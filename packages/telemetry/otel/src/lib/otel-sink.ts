import { isDevMode, signal } from '@angular/core';
import {
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  ROOT_CONTEXT,
  type SpanContext as OtelSpanContext,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { type LogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { type MetricReader, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  type IdGenerator,
  SimpleSpanProcessor,
  type SpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  type Attrs,
  type LogRecord,
  type LogSeverity,
  type MetricKind,
  type Sink,
  type SinkSpan,
  type SpanContext,
} from '@mmstack/telemetry-core';

const TRACER_NAME = '@mmstack/telemetry';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Forces the OTel span to carry our facade ids. Span creation is synchronous in
 * sdk-trace-web (generateSpanId, then generateTraceId for roots; children inherit
 * the trace id from the parent context), so ids are consumed once as they are
 * read and the call site clears any leftover in a `finally`. A reentrant
 * `startSpan` (e.g. a custom SpanProcessor starting spans in `onStart`) therefore
 * gets fresh random ids instead of duplicating the forced ones.
 * Only used when WE build the provider; with a bring-your-own provider, OTel
 * owns ids and our ids ride along as `mmstack.*` attributes instead.
 */
class ForcedIdGenerator implements IdGenerator {
  private next: SpanContext | null = null;
  private spanIdUsed = false;

  set(ctx: SpanContext): void {
    this.next = ctx;
    this.spanIdUsed = false;
  }
  clear(): void {
    this.next = null;
    this.spanIdUsed = false;
  }
  generateTraceId(): string {
    const id = this.next?.traceId ?? randomHex(16);
    this.clear(); // trace id is read last (roots only) — fully consumed
    return id;
  }
  generateSpanId(): string {
    if (this.next && !this.spanIdUsed) {
      this.spanIdUsed = true;
      return this.next.spanId;
    }
    return randomHex(8);
  }
}

function toOtelAttrs(attrs: Attrs): Attributes {
  const out: Attributes = {};
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

const SEVERITY: Record<LogSeverity, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export interface OtelSinkConfig {
  /**
   * OTLP/HTTP base endpoint (e.g. `http://localhost:4318`) — drives traces,
   * metrics, and logs (each exporter appends `/v1/{traces,metrics,logs}`).
   */
  readonly endpoint?: string;
  /** Explicit traces URL; overrides `endpoint` for traces only (back-compat). */
  readonly url?: string;
  readonly headers?: Record<string, string>;
  /** Bring your own provider. NOTE: OTel then owns ids; our facade ids ride as `mmstack.*` attrs. */
  readonly provider?: WebTracerProvider;
  /** Inject a span processor/exporter (e.g. `InMemorySpanExporter` in tests) instead of OTLP. */
  readonly processor?: SpanProcessor;
  /** Inject a metric reader (e.g. wrapping `InMemoryMetricExporter` in tests) instead of OTLP. */
  readonly metricReader?: MetricReader;
  /** Inject a log processor (e.g. `SimpleLogRecordProcessor(InMemoryLogRecordExporter)` in tests). */
  readonly logProcessor?: LogRecordProcessor;
  /** Metric export cadence when building the OTLP reader (default 60s). */
  readonly metricIntervalMs?: number;
}

/**
 * OTLP interchange adapter (one OTLP config → many backends). A capability sink
 * backed by the official OTel JS SDK — spans (with our forced ids), metrics
 * (counter/gauge/histogram), and logs (severity-mapped). Each signal is included
 * only if it has somewhere to export; returns `null` if none do, so the factory
 * drops it to noop.
 */
export function otelSink(config: OtelSinkConfig = {}): Sink | null {
  const base = config.endpoint?.replace(/\/$/, '');
  const headers = config.headers;
  const disposers: (() => void)[] = [];
  const flushables: { forceFlush(): Promise<void> }[] = [];
  const sink: Sink = {
    name: 'otel',
    ready: signal(true).asReadonly(),
    dispose: () => {
      for (const d of disposers) d();
    },
  };

  // ---- traces ----
  let provider = config.provider;
  let forced: ForcedIdGenerator | null = null;
  if (!provider) {
    const traceUrl = config.url ?? (base ? `${base}/v1/traces` : undefined);
    const processor =
      config.processor ??
      (traceUrl ? new SimpleSpanProcessor(new OTLPTraceExporter({ url: traceUrl, headers })) : null);
    if (processor) {
      forced = new ForcedIdGenerator();
      const own = new WebTracerProvider({ idGenerator: forced, spanProcessors: [processor] });
      provider = own;
      flushables.push(own);
      disposers.push(() => void own.shutdown());
    }
  }
  if (provider) {
    const tracer = provider.getTracer(TRACER_NAME);
    // BYO provider: OTel owns ids, so facade ids can't address OTel spans. Bridge
    // parenting through the OTel-side SpanContext (valid even after the parent
    // ends), FIFO-capped so a long session can't grow the map unboundedly.
    const byoCtx = forced ? null : new Map<string, OtelSpanContext>();
    sink.startSpan = (name: string, ctx: SpanContext, attrs: Attrs = {}, startMs?: number): SinkSpan => {
      const bridged = ctx.parentSpanId ? byoCtx?.get(ctx.parentSpanId) : undefined;
      const parent = bridged
        ? trace.setSpanContext(ROOT_CONTEXT, bridged)
        : forced && ctx.parentSpanId
          ? trace.setSpanContext(ROOT_CONTEXT, {
              traceId: ctx.traceId,
              spanId: ctx.parentSpanId,
              traceFlags: TraceFlags.SAMPLED,
              isRemote: false,
            })
          : ROOT_CONTEXT;

      // With our own provider, force our ids onto the OTel span; with a BYO
      // provider, surface them as correlation attributes instead.
      const attributes = forced
        ? toOtelAttrs(attrs)
        : toOtelAttrs({ ...attrs, 'mmstack.trace_id': ctx.traceId, 'mmstack.span_id': ctx.spanId });

      forced?.set(ctx);
      let span;
      try {
        span = tracer.startSpan(name, { attributes, startTime: startMs }, parent);
      } finally {
        forced?.clear();
      }
      if (byoCtx) {
        byoCtx.set(ctx.spanId, span.spanContext());
        if (byoCtx.size > 2000) {
          const oldest = byoCtx.keys().next().value;
          if (oldest !== undefined) byoCtx.delete(oldest);
        }
      }

      return {
        setAttrs: (a) => span.setAttributes(toOtelAttrs(a)),
        setError: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          span.recordException(err instanceof Error ? err : { message });
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        },
        end: (endMs?: number) => span.end(endMs),
      };
    };
  }

  // ---- metrics ----
  const reader =
    config.metricReader ??
    (base
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }),
          exportIntervalMillis: config.metricIntervalMs ?? 60_000,
        })
      : null);
  if (reader) {
    const meterProvider = new MeterProvider({ readers: [reader] });
    const meter = meterProvider.getMeter(TRACER_NAME);
    flushables.push(meterProvider);
    disposers.push(() => void meterProvider.shutdown());
    // One instrument per name: recording the same name under two kinds would
    // export conflicting duplicate streams (backends reject them) — warn instead.
    const instruments = new Map<string, { kind: MetricKind; inst: Counter | Gauge | Histogram }>();

    sink.record = (name: string, value: number, attrs: Attrs = {}, kind: MetricKind = 'histogram'): void => {
      let entry = instruments.get(name);
      if (!entry) {
        const inst =
          kind === 'counter'
            ? meter.createCounter(name)
            : kind === 'gauge'
              ? meter.createGauge(name)
              : meter.createHistogram(name);
        entry = { kind, inst };
        instruments.set(name, entry);
      } else if (entry.kind !== kind) {
        if (isDevMode()) {
          console.warn(
            `[telemetry] metric "${name}" already registered as ${entry.kind} — ${kind} record skipped`,
          );
        }
        return;
      }
      const a = toOtelAttrs(attrs);
      if (entry.kind === 'counter') (entry.inst as Counter).add(value, a);
      else (entry.inst as Gauge | Histogram).record(value, a);
    };
  }

  // ---- logs ----
  const logProcessor =
    config.logProcessor ??
    (base ? new SimpleLogRecordProcessor(new OTLPLogExporter({ url: `${base}/v1/logs`, headers })) : null);
  if (logProcessor) {
    const loggerProvider = new LoggerProvider({ processors: [logProcessor] });
    const logger = loggerProvider.getLogger(TRACER_NAME);
    flushables.push(loggerProvider);
    disposers.push(() => void loggerProvider.shutdown());
    sink.emitLog = (record: LogRecord): void => {
      logger.emit({
        severityNumber: SEVERITY[record.severity],
        severityText: record.severity.toUpperCase(),
        body: record.body,
        attributes: toOtelAttrs(record.attrs ?? {}),
        timestamp: record.timestamp,
      });
    };
  }

  if (!sink.startSpan && !sink.record && !sink.emitLog) return null; // nowhere to export

  // The periodic metric reader exports every 60s and nothing in the SDK hooks
  // page lifecycle — without this, any tab shorter than the interval exports
  // zero metrics. Flush everything when the page is hidden or unloading.
  if (flushables.length && typeof document !== 'undefined') {
    const flush = (): void => {
      if (document.visibilityState === 'hidden') {
        for (const f of flushables) void f.forceFlush().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    disposers.push(() => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    });
  }

  return sink;
}
