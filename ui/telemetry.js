import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk = null;
let tracingActive = false;

function resolveTraceEndpoint(explicitEndpoint, baseEndpoint) {
  const endpoint = explicitEndpoint || (baseEndpoint
    ? `${baseEndpoint.replace(/\/+$/, '')}/v1/traces`
    : '');
  if (!endpoint) return null;

  const parsed = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('OpenTelemetry trace endpoint must use HTTP or HTTPS.');
  }
  return parsed.toString();
}

export function initializeTracing({
  enabled = false,
  tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
} = {}) {
  if (!enabled) return false;
  if (tracingActive) return true;

  try {
    const url = resolveTraceEndpoint(tracesEndpoint, endpoint);
    if (!url) {
      console.warn('[Tracing] Enabled but no OTLP endpoint is configured; tracing remains disabled.');
      return false;
    }
    process.env.OTEL_SERVICE_NAME ||= 'lumina-edge-gateway';
    sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url }) });
    sdk.start();
    tracingActive = true;
    console.log('[Tracing] OpenTelemetry OTLP tracing enabled.');
    return true;
  } catch (error) {
    sdk = null;
    tracingActive = false;
    console.error(`[Tracing] Could not initialize OpenTelemetry: ${error.message}`);
    return false;
  }
}

export function createTracingMiddleware({
  enabled = tracingActive,
  tracer = trace.getTracer('lumina-edge-gateway'),
} = {}) {
  return function tracingMiddleware(req, res, next) {
    if (!enabled || ['/metrics', '/api/health', '/v1/models'].includes(req.path)) return next();

    const parentContext = propagation.extract(context.active(), req.headers || {});
    const span = tracer.startSpan(`${req.method || 'HTTP'} request`, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': req.method || 'GET' },
    }, parentContext);
    const requestContext = trace.setSpan(parentContext, span);
    let ended = false;

    const finishSpan = () => {
      if (ended) return;
      ended = true;
      const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
      if (routePath) {
        const route = `${req.baseUrl || ''}${routePath}`;
        span.setAttribute('http.route', route);
        span.updateName(`${req.method || 'HTTP'} ${route}`);
      }
      const statusCode = Number(res.statusCode) || 200;
      span.setAttribute('http.response.status_code', statusCode);
      if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      if (!res.writableFinished) span.setAttribute('http.client_cancelled', true);
      span.end();
    };

    res.once('finish', finishSpan);
    res.once('close', finishSpan);
    return context.with(requestContext, () => {
      try {
        return next();
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        finishSpan();
        throw error;
      }
    });
  };
}

export async function shutdownTracing() {
  if (!sdk) return;
  const activeSdk = sdk;
  sdk = null;
  tracingActive = false;
  await activeSdk.shutdown();
}
