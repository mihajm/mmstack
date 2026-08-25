import {
  computed,
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
import {
  injectPaused,
  resolvePause,
  until,
  type PauseOption,
} from '@mmstack/primitives';
import {
  applyResourceRegistration,
  type TransitionRegistration,
} from './options';
import { injectNetworkStatus } from './util';
import { type RetryOptions } from './util/retry-on-error';

/**
 * What a read-only transport hands back: the live connection's teardown. Closing it
 * must be silent — a close initiated by us (abort, pause, source change, destroy) is
 * not a failure.
 */
export type StreamConnection = { close(): void };

/**
 * A connection that can also carry messages UP. Transports returning this shape
 * (like {@link websocket}) make `streamResource` return a {@link BidiStreamResourceRef}
 * with a `send` method. `send` is only ever called while the connection is open.
 */
export type BidiStreamConnection<TOut> = StreamConnection & {
  send(message: TOut): void;
};

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
 * A read-only stream transport: open a connection to `url` and translate its lifecycle
 * into `emit`/`open`/`fail`. {@link sse} is the built-in; a custom function is the
 * extension point (and the natural test seam).
 */
export type StreamTransport<T> = (
  ctx: StreamTransportContext<T>,
) => StreamConnection;

/**
 * A bidirectional stream transport: like {@link StreamTransport}, but the connection it
 * returns can `send`. {@link websocket} is the built-in.
 */
export type BidiStreamTransport<T, TOut> = (
  ctx: StreamTransportContext<T>,
) => BidiStreamConnection<TOut>;

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

/** What a WebSocket can carry up the wire. */
export type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

/**
 * WebSocket transport (bidirectional). Incoming messages default to `JSON.parse` of
 * `event.data`; outgoing ones default to `JSON.stringify`. Pass `serialize` to send
 * binary frames or a custom wire format.
 */
export function websocket<T = unknown, TOut = unknown>(opt?: {
  protocols?: string | string[];
  deserialize?: (event: MessageEvent) => T;
  serialize?: (message: TOut) => WebSocketData;
}): BidiStreamTransport<T, TOut> {
  const deserialize =
    opt?.deserialize ?? ((ev: MessageEvent) => JSON.parse(ev.data) as T);
  const serialize =
    opt?.serialize ?? ((m: TOut): WebSocketData => JSON.stringify(m));
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
    ws.onclose = (ev) => {
      if (!closedByUs) fail(new Error(`websocket closed (code ${ev.code})`));
    };
    return {
      close: () => {
        closedByUs = true;
        ws.close();
      },
      send: (message) => ws.send(serialize(message) as never),
    };
  };
}

type BaseStreamResourceOptions<T> = {
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
  /**
   * Pause the stream while a condition holds — the live connection is CLOSED (no
   * socket kept open for a subtree nobody sees), the current value and status are
   * kept, and the stream reconnects the moment the condition lifts, with a fresh
   * backoff ladder. Same shape as the query `pause` option:
   *
   * - `true` — pause whenever the surrounding Activity boundary (`MmActivity` /
   *   `providePaused` from `@mmstack/primitives`) is paused. Outside a boundary this
   *   never pauses.
   * - a `() => boolean` predicate (a `Signal<boolean>` qualifies) — pause while it
   *   returns `true`.
   * - `false` / unset — never pause. When unset, an app-wide
   *   `providePausableOptions({ pause })` default applies, if one is configured.
   *
   * `connected` is `false` while paused; a bidi `send` while paused behaves exactly
   * like a `send` while disconnected (see {@link BidiStreamResourceOptions.outbox}).
   */
  readonly pause?: PauseOption;
  /** Called on every connection failure (including ones that will be retried). */
  readonly onError?: (error: unknown) => void;
  readonly injector?: Injector;
};

/** Options for a read-only stream (an {@link sse} or custom {@link StreamTransport}). */
export type StreamResourceOptions<T> = BaseStreamResourceOptions<T> & {
  readonly transport: StreamTransport<T>;
};

/** Options for a bidirectional stream (a {@link websocket} or custom {@link BidiStreamTransport}). */
export type BidiStreamResourceOptions<T, TOut> =
  BaseStreamResourceOptions<T> & {
    readonly transport: BidiStreamTransport<T, TOut>;
    /**
     * What `send` does while there is no open connection (connecting, reconnecting,
     * offline, paused, aborted):
     *
     * - `false` (default) — the message is DROPPED and `send` returns `false`. Check
     *   `connected()` first if you need to know up front.
     * - `true` — the message is queued and flushed, in order, on the next `open` of the
     *   SAME connection identity; `send` returns `true`. A queued message is addressed to
     *   a connection, not to the resource: a source change, `reload()`, `abort()` and
     *   `destroy()` discard the queue, and once retries are exhausted (`status: 'error'`)
     *   `send` returns `false` instead of queueing into a connection that will never come.
     *   Opt in deliberately: after a long reconnect wait the whole backlog hits the server at once.
     */
    readonly outbox?: boolean;
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
 *   The `pause` option does the same on demand (and closes an open connection).
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

/**
 * A {@link StreamResourceRef} over a bidirectional transport: the same read side plus
 * `send`, which writes to whichever connection is live right now (the socket behind a
 * reconnecting stream changes over time; callers never hold it directly).
 */
export type BidiStreamResourceRef<T, TOut> = StreamResourceRef<T> & {
  /**
   * Send a message up the live connection. Returns `true` when it was handed to the
   * connection (or queued, with `outbox: true`), `false` when there was no open
   * connection and the message was dropped.
   */
  send(message: TOut): boolean;
};

const BACKOFF_CAP = 30_000;

function reconnectPolicy(opt?: RetryOptions): { max: number; base: number } {
  if (typeof opt === 'number') return { max: opt, base: 1000 };
  return {
    max: opt?.max ?? Number.POSITIVE_INFINITY,
    base: opt?.backoff ?? 1000,
  };
}

function resolveStreamPause(
  pause: PauseOption | undefined,
  injector: Injector,
): () => boolean {
  if (pause === true) return runInInjectionContext(injector, injectPaused);
  return resolvePause({ pause, injector }, false) ?? (() => false);
}

export function streamResource<T, TOut>(
  source: () => string | undefined,
  opt: BidiStreamResourceOptions<T, TOut>,
): BidiStreamResourceRef<T, TOut>;
export function streamResource<T>(
  source: () => string | undefined,
  opt: StreamResourceOptions<T>,
): StreamResourceRef<T>;
export function streamResource<T, TOut = never>(
  source: () => string | undefined,
  opt: StreamResourceOptions<T> | BidiStreamResourceOptions<T, TOut>,
): StreamResourceRef<T> | BidiStreamResourceRef<T, TOut> {
  const injector = opt.injector ?? inject(Injector);
  const isServer = injector.get(PLATFORM_ID) === 'server';
  const online = injectNetworkStatus(injector);
  const paused = resolveStreamPause(opt.pause, injector);
  const canConnect = computed(() => online() && !paused());
  const connected = signal(false);
  const policy = reconnectPolicy(opt.reconnect);
  const outbox = 'outbox' in opt && opt.outbox ? ([] as TOut[]) : null;

  let activeDispose: (() => void) | null = null;
  let activeSuspend: (() => void) | null = null;
  let activeSend: ((message: TOut) => boolean) | null = null;

  const res = resource<T, string | undefined>({
    injector,
    params: () => (isServer ? undefined : (source() ?? undefined)),
    equal: opt.equal,
    defaultValue: opt.defaultValue as T,
    stream: ({ params: url, abortSignal }) =>
      new Promise((resolveStream) => {
        let item: WritableSignal<ResourceStreamItem<T>> | null = null;
        let conn: (StreamConnection & { send?(m: TOut): void }) | null = null;
        let attempts = 0;
        let disposed = false;
        let waiting = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const push = (next: ResourceStreamItem<T>) => {
          if (item) untracked(() => item?.set(next));
          else resolveStream((item = signal(next)));
        };

        const closeConn = () => {
          const c = conn;
          conn = null;
          c?.close();
          untracked(() => connected.set(false));
        };

        const dispose = () => {
          if (disposed) return;
          disposed = true;
          clearTimeout(retryTimer);
          closeConn();
          outbox?.splice(0);
          if (activeDispose === dispose) activeDispose = null;
          if (activeSuspend === suspend) activeSuspend = null;
          if (activeSend === send) activeSend = null;
        };

        const waitUntilAllowed = () => {
          if (waiting) return;
          waiting = true;
          void runInInjectionContext(injector, () =>
            until(canConnect, (v) => v),
          ).then(() => {
            waiting = false;
            if (disposed) return;
            attempts = 0;
            connect();
          });
        };

        // Pause while connected or mid-backoff: drop the connection, keep the stream alive.
        const suspend = () => {
          if (disposed) return;
          clearTimeout(retryTimer);
          closeConn();
          waitUntilAllowed();
        };

        // `open` may fire synchronously inside the transport factory, before `conn` is
        // assigned; the flush then runs right after assignment instead.
        const flushOutbox = () => {
          const c = conn;
          if (!outbox || !c?.send || !untracked(connected)) return;
          for (const m of outbox.splice(0)) c.send(m);
        };

        const send = (message: TOut): boolean => {
          if (conn?.send && untracked(connected)) {
            conn.send(message);
            return true;
          }
          if (!outbox || untracked(res.status) === 'error') return false;
          outbox.push(message);
          return true;
        };

        const connect = () => {
          if (disposed) return;
          if (!untracked(canConnect)) return waitUntilAllowed();
          let failedSync = false;
          const next = opt.transport({
            url: url as string,
            open: () => {
              if (disposed) return;
              attempts = 0;
              untracked(() => connected.set(true));
              flushOutbox();
            },
            emit: (value) => {
              if (disposed) return;
              attempts = 0;
              push({ value });
            },
            fail: (error) => {
              if (disposed) return;
              failedSync = true;
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
          if (failedSync) return;
          if (disposed) return next.close();
          conn = next;
          flushOutbox();
        };

        activeDispose = dispose;
        activeSuspend = suspend;
        activeSend = send;
        abortSignal.addEventListener('abort', dispose);
        connect();
      }),
  });

  effect(
    () => {
      const url = isServer ? undefined : source();
      if (url === undefined) activeDispose?.();
    },
    { injector },
  );

  effect(
    () => {
      if (paused()) untracked(() => activeSuspend?.());
    },
    { injector },
  );

  const ref: StreamResourceRef<T> = Object.assign(res, {
    connected: connected.asReadonly(),
    abort: () => {
      if (!activeDispose) return;
      outbox?.splice(0);
      res.set(untracked(res.value));
    },
  });

  const originalDestroy = ref.destroy;
  ref.destroy = () => {
    outbox?.splice(0);
    originalDestroy.call(ref);
  };

  // `send` always exists at runtime; the overloads only expose it for bidi transports.
  // On a read-only connection it reports `false` (nothing to hand the message to).
  (ref as BidiStreamResourceRef<T, TOut>).send = (message) =>
    activeSend
      ? activeSend(message)
      : outbox
        ? (outbox.push(message), true)
        : false;

  applyResourceRegistration(
    ref as ResourceRef<unknown>,
    opt.register,
    opt.injector,
  );
  return ref;
}
