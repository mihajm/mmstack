import { inject, signal } from '@angular/core';
import { type Attrs, type Sink, TelemetryHandles } from '@mmstack/telemetry-core';

/** Registry key under which the adapter publishes the current session-replay URL. */
export const POSTHOG_REPLAY_URL = 'posthog.replay_url';

/**
 * Minimal structural slice of `posthog-js` we use. Bring your own inited
 * instance (so replay/flags are configured your way); v0 bridges events and,
 * if available, surfaces the session-replay URL as a handle.
 */
export interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): void;
  /** posthog-js session-replay deep link (undefined until recording has started). */
  get_session_replay_url?(): string | undefined;
}

export interface PostHogSinkConfig {
  /** Your inited posthog-js instance; `null`/`undefined` drops the sink to noop. */
  readonly posthog: PostHogClient | null | undefined;
  /**
   * Sink name, also the handle-key namespace: the replay handle publishes under
   * `${name}.replay_url`, so two PostHog sinks don't shadow each other's handle.
   */
  readonly name?: string;
}

/**
 * Product-analytics `EventSink` over PostHog. Events emitted inside a span carry
 * `trace_id`/`span_id` (correlation) automatically via the core facade.
 * Returns `null` if no client is supplied (factory drops it to noop).
 *
 * If the client exposes `get_session_replay_url`, publishes a `posthog.replay_url`
 * handle — seeded at init and refreshed on each event, so it fills in once
 * recording starts mid-session. Returned as a factory so the handle publish
 * happens in `provideTelemetry`'s injection context.
 */
export function posthogSink(config: PostHogSinkConfig): () => Sink | null {
  return () => {
    const posthog = config.posthog;
    if (!posthog) return null;

    const name = config.name ?? 'posthog';
    const hasReplay = typeof posthog.get_session_replay_url === 'function';
    const replayUrl = signal<string | undefined>(undefined);
    const refreshReplay = (): void => {
      if (hasReplay) replayUrl.set(posthog.get_session_replay_url?.());
    };

    if (hasReplay) {
      refreshReplay();
      // namespaced by sink name (`posthog.replay_url` for the default) so two
      // instances don't shadow each other's handle
      inject(TelemetryHandles).publish(`${name}.replay_url`, replayUrl.asReadonly());
    }

    return {
      name,
      ready: signal(true).asReadonly(),
      capture(event: string, attrs?: Attrs): void {
        posthog.capture(event, attrs);
        refreshReplay();
      },
    };
  };
}
