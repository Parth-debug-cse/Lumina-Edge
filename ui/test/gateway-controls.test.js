import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createBearerAuth,
  createConcurrencyLimiter,
  createMetricsRegistry,
  createSlidingWindowRateLimiter,
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
  assert.deepEqual(limiter.stats, { active: 1, queued: 1 });
  assert.equal(rejectedRes.statusCode, 429);

  firstRes.emit('finish');
  assert.equal(admitted, 2);
  assert.deepEqual(limiter.stats, { active: 1, queued: 0 });
  secondRes.emit('finish');
  assert.deepEqual(limiter.stats, { active: 0, queued: 0 });
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
  assert.equal(invoke({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, temperature: 0.5 }).passed, true);
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
