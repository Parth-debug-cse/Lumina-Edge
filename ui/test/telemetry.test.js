import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createTracingMiddleware, initializeTracing, shutdownTracing } from '../telemetry.js';

function mockResponse() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.writableFinished = true;
  return response;
}

test('tracing is disabled by default and requires an OTLP endpoint to enable', () => {
  assert.equal(initializeTracing({ enabled: false }), false);
  assert.equal(initializeTracing({ enabled: true, tracesEndpoint: '', endpoint: '' }), false);
});

test('tracing middleware creates bounded request spans and ends them once', () => {
  const calls = [];
  const span = {
    setAttribute: (...args) => calls.push(['attribute', ...args]),
    updateName: name => calls.push(['name', name]),
    setStatus: status => calls.push(['status', status]),
    end: () => calls.push(['end']),
    recordException: error => calls.push(['exception', error]),
  };
  const tracer = {
    startSpan: (...args) => {
      calls.push(['start', ...args]);
      return span;
    },
  };
  const middleware = createTracingMiddleware({ enabled: true, tracer });
  const req = {
    method: 'POST',
    path: '/v1/chat/completions',
    baseUrl: '',
    route: { path: '/v1/chat/completions' },
    headers: { traceparent: '00-00000000000000000000000000000001-0000000000000001-01' },
  };
  const res = mockResponse();
  let nextCalls = 0;

  middleware(req, res, () => { nextCalls += 1; });
  res.emit('finish');
  res.emit('close');

  assert.equal(nextCalls, 1);
  assert.equal(calls.filter(([kind]) => kind === 'end').length, 1);
  assert(calls.some(([kind, key, value]) => kind === 'attribute' && key === 'http.route' && value === '/v1/chat/completions'));
  assert(calls.some(([kind, name]) => kind === 'name' && name === 'POST /v1/chat/completions'));
  assert(calls.some(([kind, key, value]) => kind === 'attribute' && key === 'http.response.status_code' && value === 200));
});

test('OTLP exporter sends completed spans to a local collector on shutdown', async () => {
  const requests = [];
  const collector = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, contentType: request.headers['content-type'], body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    collector.once('error', reject);
    collector.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = collector.address();
    assert(address && typeof address === 'object');
    assert.equal(initializeTracing({
      enabled: true,
      tracesEndpoint: `http://127.0.0.1:${address.port}/v1/traces`,
    }), true);

    const middleware = createTracingMiddleware();
    const req = {
      method: 'POST',
      path: '/v1/chat/completions',
      baseUrl: '',
      route: { path: '/v1/chat/completions' },
      headers: {},
      body: { messages: [{ content: 'must not be exported' }] },
    };
    const res = mockResponse();
    middleware(req, res, () => { res.emit('finish'); });
    await shutdownTracing();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/traces');
    assert.match(requests[0].contentType, /application\/json/);
    assert.match(requests[0].body, /POST \/v1\/chat\/completions/);
    assert.doesNotMatch(requests[0].body, /must not be exported/);
  } finally {
    await shutdownTracing();
    await new Promise((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  }
});
