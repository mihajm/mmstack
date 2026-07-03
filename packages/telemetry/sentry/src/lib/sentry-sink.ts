import { inject, signal } from '@angular/core';
import { type Attrs, type Sink, TelemetryHandles } from '@mmstack/telemetry-core';

/** Registry key under which the adapter publishes the most recent Sentry event id. */
export const SENTRY_LAST_EVENT_ID = 'sentry.last_event_id';

/**
 * Minimal structural slice of `@sentry/browser` we use. Bring your own inited
 * SDK/namespace (so replay/profiling are configured your way); v0 bridges errors.
 * `captureException` returns the event id — surfaced as a handle for correlation.
 */
export interface SentryClient {
  captureException(
    exception: unknown,
    hint?: { captureContext?: { extra?: Record<string, unknown> } },
  ): string;
}

export interface SentrySinkConfig {
  /** Your inited Sentry SDK/namespace; `null`/`undefined` drops the sink to noop. */
  readonly sentry: SentryClient | null | undefined;
  /**
   * Sink name, also the handle-key namespace: the event-id handle publishes under
   * `${name}.last_event_id`, so two Sentry sinks don't shadow each other's handle.
   */
  readonly name?: string;
}

/**
 * `ErrorSink` over Sentry — its proprietary strength (rich errors / source maps /
 * grouping). Attrs ride as Sentry `extra`. Errors recorded inside a span carry
 * `trace_id`/`span_id` (correlation) via the core facade. Returns `null` if no
 * client is supplied. (Traces go to Sentry via the OTLP `-otel` adapter; Sentry
 * tracing as a `SpanSink` is a follow-up.)
 *
 * Publishes a reactive `sentry.last_event_id` handle (updated on each capture) so
 * the app / other adapters can deep-link to the captured event. Returned as a
 * factory so the handle publish happens in `provideTelemetry`'s injection context.
 */
export function sentrySink(config: SentrySinkConfig): () => Sink | null {
  return () => {
    const sentry = config.sentry;
    if (!sentry) return null;

    const name = config.name ?? 'sentry';
    const lastEventId = signal<string | undefined>(undefined);
    // namespaced by sink name (`sentry.last_event_id` for the default) so two
    // instances don't shadow each other's handle
    inject(TelemetryHandles).publish(`${name}.last_event_id`, lastEventId.asReadonly());

    return {
      name,
      ready: signal(true).asReadonly(),
      recordError(err: unknown, attrs?: Attrs): void {
        const id = sentry.captureException(err, attrs ? { captureContext: { extra: attrs } } : undefined);
        lastEventId.set(id);
      },
    };
  };
}
