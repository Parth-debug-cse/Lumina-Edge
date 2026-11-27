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

  const removeWaiter = (waiter) => {
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
  };

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
    if (queue.length >= maxQueue) {
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: 'Inference capacity is busy; retry shortly' });
    }

    const waiter = { res, settled: false, grant };
    waiter.cancel = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      removeWaiter(waiter);
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      removeWaiter(waiter);
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
    get: () => ({ active, queued: queue.length, retained: queue.length }),
  });
  return middleware;
}

export function createGatewayAuthMiddleware(authMiddleware) {
  return function gatewayAuth(req, res, next) {
    const route = String(req.originalUrl || req.url || req.path || '/').split('?')[0].toLowerCase();
    if (route === '/api/health' || route === '/v1/models') return next();
    if (route === '/metrics' || route === '/api' || route.startsWith('/api/') || route === '/v1' || route.startsWith('/v1/')) {
      return authMiddleware(req, res, next);
    }
    return next();
  };
}

export function isCorsOriginAllowed(origin, { configuredOrigins = [], envOrigins = '' } = {}) {
  const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(Array.isArray(configuredOrigins) ? configuredOrigins : []),
    ...String(envOrigins).split(',').map(value => value.trim()).filter(Boolean),
  ]);
  return allowedOrigins.has(origin);
}

export function getModelProbePorts({ primaryPort, mlxPort, fallbackPort = 8091 }) {
  const gatewayPort = Number(primaryPort);
  return [...new Set([mlxPort, fallbackPort]
    .map(Number)
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65_535 && port !== gatewayPort))];
}

export function resolveGpuLayers(configured, acceleratorAvailable = false) {
  if (typeof configured === 'string' && configured.trim().toLowerCase() === 'auto') {
    return acceleratorAvailable ? 99 : 0;
  }
  const value = typeof configured === 'number' ? configured : Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function resolveBatchSize(configured, availableMemoryBytes, fallback = 256) {
  if (typeof configured === 'string' && configured.trim().toLowerCase() === 'auto') {
    const availableGiB = Number.isFinite(availableMemoryBytes) && availableMemoryBytes > 0
      ? availableMemoryBytes / (1024 ** 3)
      : 0;
    return Math.max(128, Math.min(1024, Math.floor(availableGiB / 2) * 128));
  }
  const value = typeof configured === 'number' ? configured : Number(configured);
  return Number.isSafeInteger(value) && value > 0 && value <= 4096 ? value : fallback;
}

export function resolveThreadCount(configured, detectedPhysicalCores, fallback = 4) {
  if (typeof configured === 'string' && configured.trim().toLowerCase() === 'auto') {
    return Number.isSafeInteger(detectedPhysicalCores) && detectedPhysicalCores > 0
      ? detectedPhysicalCores
      : fallback;
  }
  const value = typeof configured === 'number' ? configured : Number(configured);
  return Number.isSafeInteger(value) && value > 0 && value <= 1024 ? value : fallback;
}

export function selectReadyModel(models, policy = 'round-robin', cursor = 0) {
  const ready = models.filter(model => model.status === 'ready');
  if (!ready.length) return { model: null, nextCursor: cursor };

  const priorityOf = model => Number.isFinite(model.priority) ? model.priority : 0;
  const highestPriority = Math.max(...ready.map(priorityOf));
  let candidates = ready.filter(model => priorityOf(model) === highestPriority);

  if (policy === 'first-available') {
    return { model: candidates[0], nextCursor: cursor };
  }
  if (policy === 'load-balanced') {
    const activeCount = model => Number.isInteger(model.active_requests) ? model.active_requests : 0;
    const inferenceCount = model => Number.isInteger(model.inference_count) ? model.inference_count : 0;
    const leastActive = Math.min(...candidates.map(activeCount));
    candidates = candidates.filter(model => activeCount(model) === leastActive);
    const leastUsed = Math.min(...candidates.map(inferenceCount));
    candidates = candidates.filter(model => inferenceCount(model) === leastUsed);
  }

  const index = ((cursor % candidates.length) + candidates.length) % candidates.length;
  return { model: candidates[index], nextCursor: cursor + 1 };
}

export async function fetchJsonWithTimeout(url, { timeoutMs = 3_000, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('Timeout must be positive.');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createLineFramer(onLine) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        let line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
        if (line.length) onLine(line.toString('utf8'));
      }
    },
    flush() {
      if (pending.length) onLine(pending.toString('utf8'));
      pending = Buffer.alloc(0);
    },
  };
}

export function isAgentGoalValid(goal, maxLength = 10_000) {
  return typeof goal === 'string' && goal.trim().length > 0 && goal.length <= maxLength;
}

export function hasAgentRunCapacity(runs, maxActive) {
  let active = 0;
  for (const run of runs.values()) {
    const processAlive = run.proc && run.proc.exitCode === null && run.proc.signalCode === null;
    if (run.status === 'running' || processAlive) {
      active += 1;
      if (active >= maxActive) return false;
    }
  }
  return true;
}

export function signalChildProcess(child, signal, { platform = process.platform, killProcess = process.kill, detached = child?.detached } = {}) {
  if (!child) return false;
  if (platform !== 'win32' && detached && Number.isInteger(child.pid)) {
    try {
      killProcess(-child.pid, signal);
      return true;
    } catch {}
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
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
