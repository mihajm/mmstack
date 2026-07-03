import { signal, type Signal } from '@angular/core';
import { type Attrs } from './attrs';
import { type LogRecord, type MetricKind, type Sink, type SinkSpan, type SpanContext } from './sink';

// In-memory sink for tests — assert what telemetry was emitted. Implements every
// capability so it captures spans, events, errors, metrics, and logs.

export interface RecordedSpan {
  name: string;
  ctx: SpanContext;
  attrs: Attrs;
  ended: boolean;
  error?: unknown;
  /** Facade-stamped epoch ms — buffered spans keep their true times. */
  startMs?: number;
  endMs?: number;
}
export interface RecordedEvent {
  name: string;
  attrs?: Attrs;
}
export interface RecordedError {
  err: unknown;
  attrs?: Attrs;
}
export interface RecordedMetric {
  name: string;
  value: number;
  attrs?: Attrs;
  kind?: MetricKind;
}
export type RecordedLog = LogRecord;

export interface MemorySink extends Sink {
  readonly spans: RecordedSpan[];
  readonly events: RecordedEvent[];
  readonly errors: RecordedError[];
  readonly metrics: RecordedMetric[];
  readonly logs: RecordedLog[];
  reset(): void;
}

export function memorySink(
  name = 'memory',
  ready: Signal<boolean> = signal(true).asReadonly(),
): MemorySink {
  const spans: RecordedSpan[] = [];
  const events: RecordedEvent[] = [];
  const errors: RecordedError[] = [];
  const metrics: RecordedMetric[] = [];
  const logs: RecordedLog[] = [];

  return {
    name,
    ready,
    spans,
    events,
    errors,
    metrics,
    logs,
    startSpan(spanName: string, ctx: SpanContext, attrs: Attrs = {}, startMs?: number): SinkSpan {
      const rec: RecordedSpan = { name: spanName, ctx, attrs: { ...attrs }, ended: false, startMs };
      spans.push(rec);
      return {
        setAttrs: (a) => Object.assign(rec.attrs, a),
        setError: (e) => {
          rec.error = e;
        },
        end: (endMs?: number) => {
          rec.ended = true;
          rec.endMs = endMs;
        },
      };
    },
    capture: (eventName, attrs) => {
      events.push({ name: eventName, attrs });
    },
    recordError: (err, attrs) => {
      errors.push({ err, attrs });
    },
    record: (metricName, value, attrs, kind) => {
      metrics.push({ name: metricName, value, attrs, kind });
    },
    emitLog: (record) => {
      logs.push(record);
    },
    reset() {
      spans.length = 0;
      events.length = 0;
      errors.length = 0;
      metrics.length = 0;
      logs.length = 0;
    },
  };
}
