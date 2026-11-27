import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createBearerAuth,
  createConcurrencyLimiter,
  createGatewayAuthMiddleware,
  createLineFramer,
  createMetricsRegistry,
  createSlidingWindowRateLimiter,
  fetchJsonWithTimeout,
  getModelProbePorts,
  hasAgentRunCapacity,
  isAgentGoalValid,
  isCorsOriginAllowed,
  resolveBatchSize,
  resolveGpuLayers,
  selectReadyModel,
  resolveThreadCount,
  signalChildProcess,
  validateChatRequest,
} from '../gateway-controls.js';

function mockResponse() {
  const response = new EventEmitter();
  response.headers = {};
  response.statusCode = 200;
  response.headersSent = false;
  response.destroyed = false;
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.status = (code) => { response.statusCode = code; return response; };
  response.json = (body) => { response.body = body; response.headersSent = true; return response; };
  return response;
}

test('bearer auth rejects missing and incorrect tokens, then accepts the configured token', () => {
  const token = 'a'.repeat(40);
  const auth = createBearerAuth(token, true);
  let nextCalls = 0;
  const invoke = (authorization) => {
    const res = mockResponse();
    auth({ headers: authorization ? { authorization } : {} }, res, () => { nextCalls += 1; });
    return res;
  };

  assert.equal(invoke().statusCode, 401);
  assert.equal(invoke('Bearer wrong').statusCode, 401);
  assert.equal(invoke(`Bearer ${token}`).statusCode, 200);
  assert.equal(nextCalls, 1);
  assert.throws(() => createBearerAuth('short', true), /at least 32 bytes/);
});

test('sliding-window rate limiter returns Retry-After after the configured limit', () => {
  let time = 1_000;
  const limiter = createSlidingWindowRateLimiter({ limit: 2, windowMs: 60_000, now: () => time });
  const req = { ip: '127.0.0.1' };
  let nextCalls = 0;
  for (let i = 0; i < 2; i += 1) limiter(req, mockResponse(), () => { nextCalls += 1; });
  const limited = mockResponse();
  limiter(req, limited, () => { nextCalls += 1; });
  assert.equal(nextCalls, 2);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '60');

  time += 60_001;
  limiter(req, mockResponse(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 3);
});

test('concurrency limiter rejects non-positive queue timeouts', () => {
  assert.throws(() => createConcurrencyLimiter({ queueTimeoutMs: 0 }), /queue timeout must be positive/);
  assert.throws(() => createConcurrencyLimiter({ queueTimeoutMs: -1 }), /queue timeout must be positive/);
});

test('concurrency limiter admits bounded work and drains its FIFO queue', () => {
  const limiter = createConcurrencyLimiter({ limit: 1, maxQueue: 1, queueTimeoutMs: 1_000 });
  const firstRes = mockResponse();
  const secondRes = mockResponse();
  const rejectedRes = mockResponse();
  let admitted = 0;

  limiter({}, firstRes, () => { admitted += 1; });
  limiter({}, secondRes, () => { admitted += 1; });
  limiter({}, rejectedRes, () => { admitted += 1; });
  assert.equal(admitted, 1);
  assert.deepEqual(limiter.stats, { active: 1, queued: 1, retained: 1 });
  assert.equal(rejectedRes.statusCode, 429);

  firstRes.emit('finish');
  assert.equal(admitted, 2);
  assert.deepEqual(limiter.stats, { active: 1, queued: 0, retained: 0 });
  secondRes.emit('finish');
  assert.deepEqual(limiter.stats, { active: 0, queued: 0, retained: 0 });
});

test('cancelled and timed-out concurrency waiters are removed from retained queue storage', async () => {
  const limiter = createConcurrencyLimiter({ limit: 1, maxQueue: 2, queueTimeoutMs: 15 });
  const activeRes = mockResponse();
  const cancelledRes = mockResponse();
  limiter({}, activeRes, () => {});
  limiter({}, cancelledRes, () => {});
  cancelledRes.emit('close');
  assert.deepEqual(limiter.stats, { active: 1, queued: 0, retained: 0 });

  const timedOutRes = mockResponse();
  limiter({}, timedOutRes, () => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(timedOutRes.statusCode, 503);
  assert.deepEqual(limiter.stats, { active: 1, queued: 0, retained: 0 });
  activeRes.emit('finish');
});

test('chat request validation rejects malformed payloads and accepts valid OpenAI chat messages', () => {
  const invoke = (body) => {
    const res = mockResponse();
    let passed = false;
    validateChatRequest({ body }, res, () => { passed = true; });
    return { res, passed };
  };
  assert.equal(invoke({ messages: [] }).res.statusCode, 400);
  assert.equal(invoke({ messages: [{ role: 'system', content: 'hello' }], max_tokens: 0 }).res.statusCode, 400);
  assert.equal(invoke({ messages: [{ role: 'user', content: [{ type: 'unknown', value: 'x' }] }] }).res.statusCode, 400);
  assert.equal(invoke({ messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'bad name' } }] }).res.statusCode, 400);
  assert.equal(invoke({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, temperature: 0.5 }).passed, true);
  assert.equal(invoke({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto',
  }).passed, true);
});

test('gateway authentication canonicalizes case while preserving public liveness routes', () => {
  const token = 'b'.repeat(40);
  const middleware = createGatewayAuthMiddleware(createBearerAuth(token, true));
  const invoke = (path, authorization) => {
    const res = mockResponse();
    let passed = false;
    middleware({ originalUrl: path, headers: authorization ? { authorization } : {} }, res, () => { passed = true; });
    return { res, passed };
  };

  assert.equal(invoke('/API/SETTINGS?view=1').res.statusCode, 401);
  assert.equal(invoke('/V1/CHAT/COMPLETIONS').res.statusCode, 401);
  assert.equal(invoke('/API/SETTINGS', `Bearer ${token}`).passed, true);
  assert.equal(invoke('/API/HEALTH').passed, true);
  assert.equal(invoke('/V1/MODELS').passed, true);
});

test('model discovery excludes the gateway and deduplicates backend probes', () => {
  assert.deepEqual(getModelProbePorts({ primaryPort: 8090, mlxPort: 8090 }), [8091]);
  assert.deepEqual(getModelProbePorts({ primaryPort: 8090, mlxPort: 8091 }), [8091]);
});

test('GPU layer auto-detection preserves explicit CPU-only zero settings', () => {
  assert.equal(resolveGpuLayers(0, true), 0);
  assert.equal(resolveGpuLayers('0', true), 0);
  assert.equal(resolveGpuLayers(15, false), 15);
  assert.equal(resolveGpuLayers('auto', true), 99);
  assert.equal(resolveGpuLayers('auto', false), 0);
  assert.equal(resolveGpuLayers('invalid', true), 0);
});

test('automatic batch and thread settings use bounded hardware values', () => {
  assert.equal(resolveBatchSize('auto', 4 * 1024 ** 3), 256);
  assert.equal(resolveBatchSize('auto', 16 * 1024 ** 3), 1024);
  assert.equal(resolveBatchSize('auto', 0), 128);
  assert.equal(resolveBatchSize(0, 8 * 1024 ** 3), 256);
  assert.equal(resolveBatchSize(512, 8 * 1024 ** 3), 512);
  assert.equal(resolveThreadCount('auto', 8), 8);
  assert.equal(resolveThreadCount('auto', 0), 4);
  assert.equal(resolveThreadCount(0, 8), 4);
});

test('router policies select ready models by priority, load, and round-robin order', () => {
  const models = [
    { id: 'cpu', status: 'ready', priority: 0, active_requests: 0, inference_count: 0 },
    { id: 'high-a', status: 'ready', priority: 10, active_requests: 1, inference_count: 4 },
    { id: 'high-b', status: 'ready', priority: 10, active_requests: 1, inference_count: 4 },
    { id: 'loading', status: 'loading', priority: 100, active_requests: 0, inference_count: 0 },
  ];
  assert.equal(selectReadyModel(models, 'first-available').model.id, 'high-a');
  assert.equal(selectReadyModel(models, 'round-robin', 0).model.id, 'high-a');
  assert.equal(selectReadyModel(models, 'round-robin', 1).model.id, 'high-b');
  assert.equal(selectReadyModel(models, 'load-balanced', 0).model.id, 'high-a');
  assert.equal(selectReadyModel(models, 'load-balanced', 1).model.id, 'high-b');
  assert.equal(selectReadyModel([{ status: 'loading' }]).model, null);
});

test('router honors requested model IDs, names, and paths instead of silently selecting another model', () => {
  const models = [
    { id: 'router-id', name: 'qwen2.5-0.5b.gguf', path: '/models/qwen2.5-0.5b.gguf', status: 'ready', priority: 10 },
    { id: 'other', name: 'mistral.gguf', path: '/models/mistral.gguf', status: 'ready', priority: 0 },
  ];
  assert.equal(selectReadyModel(models, 'round-robin', 0, 'mistral').model.id, 'other');
  assert.equal(selectReadyModel(models, 'round-robin', 0, '/models/qwen2.5-0.5b.gguf').model.id, 'router-id');
  assert.equal(selectReadyModel(models, 'round-robin', 0, 'unknown').requestedModelError, 'not_found');
  assert.equal(selectReadyModel(models, 'round-robin', 0, 'local').model.id, 'router-id');
  assert.equal(selectReadyModel([{ status: 'loading' }], 'round-robin', 0, 'unknown').requestedModelError, undefined);
});

test('model discovery fetch has an actual abort timeout covering JSON body parsing', async () => {
  await assert.rejects(fetchJsonWithTimeout('http://127.0.0.1:8091/v1/models', {
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), { name: 'TimeoutError' });

  const result = await fetchJsonWithTimeout('http://127.0.0.1:8091/v1/models', {
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  assert.deepEqual(result, { data: [] });
});

test('CORS origin check uses only the configured allowlist, including for streams', () => {
  assert.equal(isCorsOriginAllowed('http://localhost:5173'), true);
  assert.equal(isCorsOriginAllowed('http://localhost:3000'), false);
  assert.equal(isCorsOriginAllowed('https://app.example', {
    configuredOrigins: ['https://app.example'],
    envOrigins: 'https://other.example, https://second.example',
  }), true);
  assert.equal(isCorsOriginAllowed('https://other.example', { envOrigins: 'https://other.example' }), true);
});

test('agent input and active-run limits are bounded', () => {
  assert.equal(isAgentGoalValid('summarize this'), true);
  assert.equal(isAgentGoalValid(' '.repeat(3)), false);
  assert.equal(isAgentGoalValid('x'.repeat(11), 10), false);

  const runs = new Map([
    ['completed', { status: 'done', proc: { exitCode: 0, signalCode: null } }],
    ['active-one', { status: 'done', proc: { exitCode: null, signalCode: null } }],
    ['active-two', { status: 'running', proc: null }],
  ]);
  assert.equal(hasAgentRunCapacity(runs, 2), false);
  runs.get('active-one').proc.exitCode = 0;
  assert.equal(hasAgentRunCapacity(runs, 2), true);
});

test('agent stdout framing handles split JSON events, UTF-8 chunks, CRLF, and a final unterminated line', () => {
  const lines = [];
  const framer = createLineFramer(line => lines.push(line));
  const output = Buffer.from('{"type":"step","data":"café"}\r\n{"type":"done","data":{"ok":true}}');
  const utf8Split = Buffer.from('{"type":"step","data":"caf').length + 1;
  framer.push(output.subarray(0, utf8Split));
  framer.push(output.subarray(utf8Split, utf8Split + 9));
  framer.push(output.subarray(utf8Split + 9));
  framer.flush();
  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { type: 'step', data: 'café' },
    { type: 'done', data: { ok: true } },
  ]);
});

test('agent termination targets the detached process group when available and falls back on Windows', () => {
  const signals = [];
  const child = { pid: 1234, kill: signal => signals.push(['child', signal]) };
  assert.equal(signalChildProcess(child, 'SIGTERM', {
    platform: 'linux',
    detached: true,
    killProcess: (pid, signal) => signals.push([pid, signal]),
  }), true);
  assert.deepEqual(signals, [[-1234, 'SIGTERM']]);

  signalChildProcess(child, 'SIGKILL', { platform: 'win32' });
  assert.deepEqual(signals[1], ['child', 'SIGKILL']);
});

test('metrics render Prometheus counters and latency histogram samples', () => {
  const registry = createMetricsRegistry({ buckets: [1] });
  const req = { method: 'GET', baseUrl: '/api', route: { path: '/health' } };
  const res = mockResponse();
  registry.middleware(req, res, () => {});
  res.emit('finish');
  const rendered = registry.render({ active: 1, queued: 2 });
  assert.match(rendered, /lumina_http_requests_total\{method="GET",route="\/api\/health",status="200"\} 1/);
  assert.match(rendered, /lumina_http_request_duration_seconds_bucket\{route="\/api\/health",le="\+Inf"\} 1/);
  assert.match(rendered, /lumina_inference_requests_active 1/);
  assert.match(rendered, /lumina_inference_requests_queued 2/);
});
