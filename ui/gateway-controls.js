import { timingSafeEqual } from 'node:crypto';

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function createBearerAuth(token, enabled = Boolean(token)) {
  if (enabled && (!token || Buffer.byteLength(token) < 32)) {
    throw new Error('Token authentication requires LUMINA_API_TOKEN to contain at least 32 bytes.');
  }

  const expected = token ? Buffer.from(token) : null;
  return function bearerAuth(req, res, next) {
    if (!enabled) return next();
    const header = req.headers?.authorization || '';
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Bearer token required' });
    }

    const supplied = Buffer.from(match[1]);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Invalid bearer token' });
    }
    return next();
  };
}

export function createSlidingWindowRateLimiter({ limit = 10, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new TypeError('Rate limit and window must be positive.');
  }
  const requests = new Map();
  let calls = 0;

  return function rateLimit(req, res, next) {
    const time = now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const recent = (requests.get(key) || []).filter(timestamp => time - timestamp < windowMs);
    if (recent.length >= limit) {
      requests.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((windowMs - (time - recent[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Rate limit exceeded', retry_after_seconds: retryAfter });
    }

    recent.push(time);
    requests.set(key, recent);
    calls += 1;
    if (calls % 256 === 0 || requests.size > maxKeys) {
      for (const [address, timestamps] of requests) {
        if (!timestamps.length || time - timestamps[timestamps.length - 1] >= windowMs) requests.delete(address);
      }
      while (requests.size > maxKeys) requests.delete(requests.keys().next().value);
    }
    return next();
  };
}

export function createConcurrencyLimiter({ limit = 2, maxQueue = 8, queueTimeoutMs = 30_000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new TypeError('Concurrency limit must be positive and queue length cannot be negative.');
  }
  let active = 0;
  const queue = [];

  const attachRelease = (res) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      while (queue.length) {
        const waiter = queue.shift();
        if (waiter.settled) continue;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.res.removeListener?.('close', waiter.cancel);
        waiter.grant(true);
        return;
      }
      active -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
  };

  const middleware = function concurrencyLimit(req, res, next) {
    const grant = (slotTransferred = false) => {
      if (!slotTransferred) active += 1;
      attachRelease(res);
      next();
    };

    if (active < limit) return grant();
    if (queue.filter(waiter => !waiter.settled).length >= maxQueue) {
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: 'Inference capacity is busy; retry shortly' });
    }

    const waiter = { res, settled: false, grant };
    waiter.cancel = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      waiter.res.removeListener?.('close', waiter.cancel);
      if (!waiter.res.headersSent && !waiter.res.destroyed) {
        waiter.res.setHeader('Retry-After', '1');
        waiter.res.status(503).json({ error: 'Timed out waiting for inference capacity' });
      }
    }, queueTimeoutMs);
    waiter.timer.unref?.();
    res.once('close', waiter.cancel);
    queue.push(waiter);
  };

  Object.defineProperty(middleware, 'stats', {
    get: () => ({ active, queued: queue.filter(waiter => !waiter.settled).length }),
  });
  return middleware;
}

export function createMetricsRegistry({ buckets = DEFAULT_BUCKETS } = {}) {
  const requests = new Map();
  const durations = new Map();

  const middleware = function metricsMiddleware(req, res, next) {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : '/unmatched';
      const key = JSON.stringify([req.method || 'GET', route, String(res.statusCode || 200)]);
      requests.set(key, (requests.get(key) || 0) + 1);
      const stats = durations.get(route) || { count: 0, sum: 0, buckets: buckets.map(() => 0) };
      stats.count += 1;
      stats.sum += elapsed;
      buckets.forEach((bound, index) => { if (elapsed <= bound) stats.buckets[index] += 1; });
      durations.set(route, stats);
    });
    next();
  };

  function render({ active = 0, queued = 0 } = {}) {
    const lines = [
      '# HELP lumina_http_requests_total Total completed HTTP requests.',
      '# TYPE lumina_http_requests_total counter',
    ];
    for (const [key, count] of requests) {
      const [method, route, status] = JSON.parse(key);
      lines.push(`lumina_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${count}`);
    }
    lines.push('# HELP lumina_http_request_duration_seconds HTTP request duration in seconds.', '# TYPE lumina_http_request_duration_seconds histogram');
    for (const [route, stats] of durations) {
      buckets.forEach((bound, index) => lines.push(`lumina_http_request_duration_seconds_bucket{route="${escapeLabel(route)}",le="${bound}"} ${stats.buckets[index]}`));
      lines.push(`lumina_http_request_duration_seconds_bucket{route="${escapeLabel(route)}",le="+Inf"} ${stats.count}`);
      lines.push(`lumina_http_request_duration_seconds_sum{route="${escapeLabel(route)}"} ${stats.sum}`);
      lines.push(`lumina_http_request_duration_seconds_count{route="${escapeLabel(route)}"} ${stats.count}`);
    }
    lines.push('# HELP lumina_inference_requests_active Active inference requests.', '# TYPE lumina_inference_requests_active gauge', `lumina_inference_requests_active ${active}`, '# HELP lumina_inference_requests_queued Inference requests waiting for capacity.', '# TYPE lumina_inference_requests_queued gauge', `lumina_inference_requests_queued ${queued}`);
    return `${lines.join('\n')}\n`;
  }

  return { middleware, render };
}

export function validateChatRequest(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 128) {
    return res.status(400).json({ error: 'messages must be an array containing 1 to 128 items' });
  }
  const validRoles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !validRoles.has(message.role)) {
      return res.status(400).json({ error: 'Each message must have a supported role' });
    }
    if (typeof message.content !== 'string' && !Array.isArray(message.content) && message.content !== null) {
      return res.status(400).json({ error: 'Message content must be a string, array, or null' });
    }
    if (typeof message.content === 'string' && message.content.length > 200_000) {
      return res.status(413).json({ error: 'A message exceeds the 200000 character limit' });
    }
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 512)) {
    return res.status(400).json({ error: 'model must be a string of at most 512 characters' });
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return res.status(400).json({ error: 'stream must be a boolean' });
  }
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 32_768)) {
    return res.status(400).json({ error: 'max_tokens must be an integer from 1 to 32768' });
  }
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    return res.status(400).json({ error: 'temperature must be between 0 and 2' });
  }
  if (body.top_p !== undefined && (!Number.isFinite(body.top_p) || body.top_p <= 0 || body.top_p > 1)) {
    return res.status(400).json({ error: 'top_p must be greater than 0 and at most 1' });
  }
  return next();
}

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
