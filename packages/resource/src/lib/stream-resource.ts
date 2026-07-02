import {
  effect,
  inject,
  Injector,
  PLATFORM_ID,
  resource,
  runInInjectionContext,
  signal,
  untracked,
  type ResourceRef,
  type ResourceStreamItem,
  type Signal,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';
import { until } from '@mmstack/primitives';
import { applyResourceRegistration, type TransitionRegistration } from './options';
import { injectNetworkStatus } from './util';
import { type RetryOptions } from './util/retry-on-error';

/**
 * What a transport hands back: the live connection's teardown. Closing it must be
 * silent — a close initiated by us (abort, source change, destroy) is not a failure.
 */
export type StreamConnection = { close(): void };

/** The callbacks a transport drives; the reconnect/status machinery reacts to them. */
export type StreamTransportContext<T> = {
  readonly url: string;
  /** A message arrived — becomes the resource's next value. */
  emit(value: T): void;
  /** The connection is established — flips `connected`, resets the backoff ladder. */
  open(): void;
  /** The CONNECTION failed (dropped, refused, poison message) — reconnect policy decides. */
  fail(error: unknown): void;
};

/**
 * A stream transport: open a connection to `url` and translate its lifecycle into
 * `emit`/`open`/`fail`. {@link sse} and {@link websocket} are the built-ins; a custom
 * function is the extension point (and the natural test seam).
 */
export type StreamTransport<T> = (
  ctx: StreamTransportContext<T>,
) => StreamConnection;

/**
 * Server-Sent Events transport. Messages default to `JSON.parse` of `event.data`.
 * The native `EventSource` auto-reconnect is deliberately disabled (the source closes
 * on error) so ONE reconnection policy — `streamResource`'s, with network gating and
 * capped backoff — owns the behavior uniformly across transports.
 */
export function sse<T = unknown>(opt?: {
  /** Listen to a named event instead of the default `message` events. */
  event?: string;
  withCredentials?: boolean;
  deserialize?: (data: string) => T;
}): StreamTransport<T> {
  const deserialize = opt?.deserialize ?? ((d: string) => JSON.parse(d) as T);
  return ({ url, emit, open, fail }) => {
    const es = new EventSource(url, { withCredentials: opt?.withCredentials });
    es.onopen = () => open();
    const onMessage = (ev: MessageEvent) => {
      try {
        emit(deserialize(ev.data as string));
      } catch (err) {
        es.close();
        fail(err);
      }
    };
    if (opt?.event) es.addEventListener(opt.event, onMessage);
    else es.onmessage = onMessage;
    es.onerror = () => {
      es.close();
      fail(new Error(`SSE connection to '${url}' failed`));
    };
    return { close: () => es.close() };
  };
}

/** WebSocket transport (read side). Messages default to `JSON.parse` of `event.data`. */
export function websocket<T = unknown>(opt?: {
  protocols?: string | string[];
  deserialize?: (event: MessageEvent) => T;
}): StreamTransport<T> {
  const deserialize =
    opt?.deserialize ?? ((ev: MessageEvent) => JSON.parse(ev.data) as T);
  return ({ url, emit, open, fail }) => {
    let closedByUs = false;
    const ws = new WebSocket(url, opt?.protocols);
    ws.onopen = () => open();
    ws.onmessage = (ev) => {
      try {
        emit(deserialize(ev));
      } catch (err) {
        closedByUs = true;
        ws.close();
        fail(err);
      }
    };
    // onerror always precedes onclose; the close event carries the actionable signal
    ws.onclose = (ev) => {
      if (!closedByUs) fail(new Error(`websocket closed (code ${ev.code})`));
    };
    return {
      close: () => {
        closedByUs = true;
        ws.close();
      },
    };
  };
}

export type StreamResourceOptions<T> = {
  readonly transport: StreamTransport<T>;
  readonly defaultValue?: T;
  readonly equal?: ValueEqualityFn<T>;
  /**
   * Reconnection policy after a connection failure — same shape as query `retry`
   * (`number` = max attempts, or `{ max, backoff }`). Streams default to PERSISTENT:
   * unlimited attempts with exponential backoff from 1s, capped at 30s — a live
   * connection's job is to be alive. Pass `0` for single-shot. Backoff resets on every
   * successful open and on network regain; while offline nothing burns attempts — the
   * next try waits for the network.
   */
  readonly reconnect?: RetryOptions;
  /** Auto-registration into the nearest transition scope (resource vocabulary). */
  readonly register?: TransitionRegistration;
  /** Called on every connection failure (including ones that will be retried). */
  readonly onError?: (error: unknown) => void;
  readonly injector?: Injector;
};

/**
 * A live-connection resource (SSE / WebSocket / custom transport) with the standard
 * resource status surface — so a stream participates in transition scopes, suspense
 * boundaries, and `latest()` like any other resource:
 *
 * - `status` is `'loading'` until the FIRST message lands (a connection with no data
 *   yet is honestly not ready), then `'resolved'` with `value` tracking every message.
 * - Connection drops are handled by the reconnect policy (see
 *   {@link StreamResourceOptions.reconnect}); the last value HOLDS through reconnects —
 *   only exhausted retries surface as `status: 'error'`. `connected` is the live
 *   connection indicator for UX (dot in the corner), independent of value/status.
 * - Offline pauses reconnection (no attempts burned); regain reconnects immediately.
 * - A reactive `source` URL change tears the old connection down and connects anew;
 *   `undefined` disconnects (status `'idle'`) — the disable lever.
 * - `abort()` (the {@link ResourceLike} cancellation seam) disconnects and STAYS
 *   disconnected, keeping the current value (`status: 'local'`); `reload()` or a source
 *   change reconnects.
 * - SSR: never connects on the server (status `'idle'`) — a stream never settles, so
 *   connecting would wedge serialization. Streams are client-only by design.
 */
export type StreamResourceRef<T> = ResourceRef<T> & {
  /** Live connection indicator — true between `open` and the next drop/close. */
  readonly connected: Signal<boolean>;
  /** Disconnect and stay disconnected, keeping the current value. See type docs. */
  abort(): void;
};

const BACKOFF_CAP = 30_000;

function reconnectPolicy(opt?: RetryOptions): { max: number; base: number } {
  if (typeof opt === 'number') return { max: opt, base: 1000 };
  return { max: opt?.max ?? Number.POSITIVE_INFINITY, base: opt?.backoff ?? 1000 };
}

export function streamResource<T>(
  source: () => string | undefined,
  opt: StreamResourceOptions<T>,
): StreamResourceRef<T> {
  const injector = opt.injector ?? inject(Injector);
  const isServer = injector.get(PLATFORM_ID) === 'server';
  const online = injectNetworkStatus(injector);
  const connected = signal(false);
  const policy = reconnectPolicy(opt.reconnect);

  // Angular's loadEffect early-returns on an undefined request WITHOUT aborting the
  // in-progress stream (status flips to idle, but a live connection would linger) —
  // the current loader parks its teardown here so the disable lever can reach it.
  let activeDispose: (() => void) | null = null;

  const res = resource<T, string | undefined>({
    injector,
    params: () => (isServer ? undefined : (source() ?? undefined)),
    equal: opt.equal,
    defaultValue: opt.defaultValue as T,
    stream: ({ params: url, abortSignal }) =>
      new Promise((resolveStream) => {
        let item: WritableSignal<ResourceStreamItem<T>> | null = null;
        let conn: StreamConnection | null = null;
        let attempts = 0;
        let disposed = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const push = (next: ResourceStreamItem<T>) => {
          if (item) untracked(() => item?.set(next));
          else resolveStream((item = signal(next)));
        };

        const dispose = () => {
          if (disposed) return;
          disposed = true;
          clearTimeout(retryTimer);
          const c = conn;
          conn = null;
          c?.close();
          untracked(() => connected.set(false));
          if (activeDispose === dispose) activeDispose = null;
        };
        activeDispose = dispose;
        abortSignal.addEventListener('abort', dispose);

        const waitForOnline = () => {
          void runInInjectionContext(injector, () =>
            until(online, (v) => v),
          ).then(() => {
            if (disposed) return;
            attempts = 0; // a regained network is a fresh start
            connect();
          });
        };

        const connect = () => {
          if (disposed) return;
          if (!untracked(online)) return waitForOnline();
          conn = opt.transport({
            url: url as string,
            open: () => {
              if (disposed) return;
              attempts = 0;
              untracked(() => connected.set(true));
            },
            emit: (value) => {
              if (disposed) return;
              attempts = 0;
              push({ value });
            },
            fail: (error) => {
              if (disposed) return;
              conn = null;
              untracked(() => connected.set(false));
              opt.onError?.(error);
              if (attempts >= policy.max)
                return push({
                  error:
                    error instanceof Error
                      ? error
                      : new Error(String(error), { cause: error }),
                });
              attempts++;
              const delay = Math.min(
                policy.base * 2 ** (attempts - 1),
                BACKOFF_CAP,
              );
              retryTimer = setTimeout(connect, delay);
            },
          });
        };

        connect();
      }),
  });

  // the disable lever: params → undefined must actually hang up (see activeDispose)
  effect(
    () => {
      const url = isServer ? undefined : source();
      if (url === undefined) activeDispose?.();
    },
    { injector },
  );

  const ref: StreamResourceRef<T> = Object.assign(res, {
    connected: connected.asReadonly(),
    abort: () => {
      const s = untracked(res.status);
      if (s !== 'loading' && s !== 'reloading' && !untracked(connected)) return;
      // a self-set aborts the stream loader (Angular's abortInProgressLoad) → the
      // abort listener above closes the connection; value kept, status 'local'
      res.set(untracked(res.value));
    },
  });

  applyResourceRegistration(
    ref as ResourceRef<unknown>,
    opt.register,
    opt.injector,
  );
  return ref;
}
