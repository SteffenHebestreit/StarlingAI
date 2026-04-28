/**
 * OpenTelemetry tracing — produces spans for tool calls, sub-agent runs, and
 * federation requests, propagating trace context across the
 * federation HTTP boundary so a delegation that hops three instances shows
 * up as a single trace in Jaeger / Tempo / Honeycomb.
 *
 * Initialization is lazy and idempotent: the first call to
 * `initTracing()` reads the config and starts the SDK; subsequent calls
 * are no-ops.  When tracing is disabled, all helpers (`withSpan`,
 * `injectTraceContext`, etc.) return cheaply without producing spans, so
 * the rest of the codebase can call them unconditionally.
 */
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
  type Span,
  type Tracer,
  type Attributes,
} from "@opentelemetry/api";
import { childLogger } from "../logger.js";
import type { TracingConfig } from "../config/schema.js";

const log = childLogger("tracing");

const TRACER_NAME = "starlingai";
const TRACER_VERSION = "0.7.0";

let _initialized = false;
let _enabled = false;
let _shutdown: (() => Promise<void>) | null = null;

/** Lazy-loaded tracer.  Returns a no-op tracer when SDK is not initialized. */
function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

export function isTracingEnabled(): boolean {
  return _enabled;
}

/**
 * Bootstrap the OpenTelemetry SDK.  Safe to call multiple times — only
 * the first call has effect.  Returns true when tracing is now active,
 * false when disabled or the bootstrap failed (failures are logged but
 * never thrown so a misconfigured exporter cannot prevent the gateway
 * from starting).
 */
export async function initTracing(config: TracingConfig): Promise<boolean> {
  if (_initialized) return _enabled;
  _initialized = true;

  if (!config.enabled) {
    log.debug("Tracing disabled in config");
    return false;
  }

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import("@opentelemetry/semantic-conventions");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } = await import("@opentelemetry/sdk-trace-base");

    const exporter = new OTLPTraceExporter({
      url: config.otlpEndpoint,
      headers: config.otlpHeaders,
    });

    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Math.min(1, Math.max(0, config.sampleRate))),
    });

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: TRACER_VERSION,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
      sampler,
    });

    sdk.start();
    _shutdown = () => sdk.shutdown();
    _enabled = true;
    log.info({ endpoint: config.otlpEndpoint, sampleRate: config.sampleRate, serviceName: config.serviceName }, "OpenTelemetry tracing started");
    return true;
  } catch (err) {
    log.warn({ err }, "Failed to start OpenTelemetry tracing — continuing without spans");
    return false;
  }
}

/** Graceful shutdown — flushes pending spans to the exporter. */
export async function shutdownTracing(): Promise<void> {
  if (_shutdown) {
    try { await _shutdown(); } catch (err) { log.warn({ err }, "tracing shutdown failed"); }
    _shutdown = null;
  }
  _enabled = false;
  _initialized = false;
}

/**
 * Wrap a function in a span.  When tracing is disabled this is a thin
 * passthrough — there's no SDK overhead to skip.  Errors propagate after
 * being recorded on the span.
 */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  if (!_enabled) {
    // Run inline; pass a no-op span so callers don't have to branch.
    const span = trace.getActiveSpan();
    if (span) return fn(span);
    return fn(getTracer().startSpan(name, { kind, attributes: attrs }));
  }
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { kind, attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Inject the current trace context into an outbound HTTP headers object so
 * a federation peer can stitch its spans into our trace.  Mutates the
 * `headers` object in place (and returns it for chaining).
 */
export function injectTraceContext(headers: Record<string, string>): Record<string, string> {
  if (!_enabled) return headers;
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Extract trace context from inbound HTTP headers and run `fn` inside the
 * extracted context so any spans produced by `fn` are children of the
 * caller's trace.  When tracing is disabled or the headers contain no
 * propagation data, `fn` runs in the current context.
 */
export async function withExtractedContext<T>(
  headers: Record<string, string | string[] | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!_enabled) return fn();
  // OTel propagation expects a flat string-valued carrier.
  const carrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") carrier[k.toLowerCase()] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") carrier[k.toLowerCase()] = v[0];
  }
  const extracted = propagation.extract(context.active(), carrier);
  return context.with(extracted, fn);
}

/** Set common attributes on the active span, no-op when tracing is disabled. */
export function setSpanAttributes(attrs: Attributes): void {
  if (!_enabled) return;
  trace.getActiveSpan()?.setAttributes(attrs);
}

/** Test-only: reset internal state so initTracing can run again. */
export function _resetTracingForTests(): void {
  _initialized = false;
  _enabled = false;
  _shutdown = null;
}
