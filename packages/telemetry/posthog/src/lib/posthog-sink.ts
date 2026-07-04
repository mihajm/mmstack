import { inject, signal } from '@angular/core';
import {
  type Attrs,
  type Sink,
  TelemetryHandles,
} from '@mmstack/telemetry-core';

/** Registry key under which the adapter publishes the current session-replay URL. */
export const POSTHOG_REPLAY_URL = 'posthog.replay_url';

/**
 * Minimal structural slice of `posthog-js` we use. Bring your own inited
 * instance (so replay/flags are configured your way). The adapter bridges events
 * (`EventSink`), and — when the client exposes them — exception capture
 * (`ErrorSink`), user identity (`IdentitySink`), session super-properties
 * (`GlobalAttrsSink`), and the session-replay URL as a handle. Each is
 * feature-detected, so the sink advertises only what the client supports.
 */
export interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): void;
  /** posthog-js exception capture; when present the sink implements `ErrorSink`. */
  captureException?(error: unknown, properties?: Record<string, unknown>): void;
  /** posthog-js person identify; when present the sink implements `IdentitySink`. */
  identify?(distinctId: string, properties?: Record<string, unknown>): void;
  /** posthog-js identity reset (logout); called by `telemetry.identify(null)`. */
  reset?(): void;
  /**
   * posthog-js SESSION super-properties (matches the facade's session-scoped
   * `setGlobalAttrs`); when present the sink implements `GlobalAttrsSink` so
   * posthog's out-of-band autocapture carries them too.
   */
  register_for_session?(properties: Record<string, unknown>): void;
  /** posthog-js super-property removal (for a `setGlobalAttrs` key set to `undefined`). */
  unregister?(property: string): void;
  /** posthog-js session-replay deep link (undefined until recording has started). */
  get_session_replay_url?(): string | undefined;
}

export type PostHogSinkConfig = {
  /** Your inited posthog-js instance; `null`/`undefined` drops the sink to noop. */
  readonly posthog: PostHogClient | null | undefined;
  /**
   * Sink name, also the handle-key namespace: the replay handle publishes under
   * `${name}.replay_url`, so two PostHog sinks don't shadow each other's handle.
   */
  readonly name?: string;
};

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
      inject(TelemetryHandles).publish(
        `${name}.replay_url`,
        replayUrl.asReadonly(),
      );
    }

    const sink: Sink = {
      name,
      ready: signal(true).asReadonly(),
      capture(event: string, attrs?: Attrs): void {
        posthog.capture(event, attrs);
        refreshReplay();
      },
    };

    // advertise ErrorSink only when the client can capture exceptions, so
    // `telemetry.error()` reaches PostHog instead of silently no-opping here
    if (typeof posthog.captureException === 'function') {
      sink.recordError = (err: unknown, attrs?: Attrs): void => {
        posthog.captureException?.(err, attrs);
        refreshReplay();
      };
    }

    // IdentitySink: identify(null) is logout → reset
    if (typeof posthog.identify === 'function') {
      sink.identify = (userId: string | null, traits?: Attrs): void => {
        if (userId === null) posthog.reset?.();
        else posthog.identify?.(userId, traits);
      };
    }

    // GlobalAttrsSink: session super-properties; an undefined value unregisters the key
    if (typeof posthog.register_for_session === 'function') {
      sink.setGlobalAttrs = (attrs: Attrs): void => {
        const props: Record<string, unknown> = {};
        for (const key of Object.keys(attrs)) {
          if (attrs[key] === undefined) posthog.unregister?.(key);
          else props[key] = attrs[key];
        }
        if (Object.keys(props).length) posthog.register_for_session?.(props);
      };
    }

    return sink;
  };
}
