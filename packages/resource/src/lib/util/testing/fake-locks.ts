import { type MutationSyncChannel } from '../persist-mutations';

type Mode = 'exclusive' | 'shared';

type Request = {
  readonly name: string;
  readonly mode: Mode;
  readonly signal?: AbortSignal;
  readonly start: () => void;
  readonly fail: (err: unknown) => void;
  settled: boolean;
};

const MODES: readonly string[] = ['exclusive', 'shared'];

/**
 * An in-memory LockManager that follows the Web Locks request algorithm closely enough for the
 * persistence specs: grants arrive on a later microtask (never inside `request`), the callback
 * runs after the grant, an abort only rejects a request that is still queued, an unknown `mode`
 * rejects with a TypeError, and `ifAvailable` together with `signal` rejects with
 * NotSupportedError.
 */
export function createFakeLocks(): LockManager {
  const held = new Map<string, { mode: Mode }[]>();
  const queues = new Map<string, Request[]>();

  const holdersOf = (name: string) => {
    let holders = held.get(name);
    if (!holders) held.set(name, (holders = []));
    return holders;
  };
  const queueOf = (name: string) => {
    let queue = queues.get(name);
    if (!queue) queues.set(name, (queue = []));
    return queue;
  };
  const compatible = (name: string, mode: Mode) => {
    const holders = holdersOf(name);
    return (
      !holders.length ||
      (mode === 'shared' && holders.every((h) => h.mode === 'shared'))
    );
  };

  const acquire = (name: string, mode: Mode) => {
    const holder = { mode };
    holdersOf(name).push(holder);
    return () => {
      const holders = holdersOf(name);
      const idx = holders.indexOf(holder);
      if (idx >= 0) holders.splice(idx, 1);
      pump(name);
    };
  };

  const pump = (name: string) => {
    const queue = queueOf(name);
    while (queue.length) {
      const next = queue[0];
      if (!compatible(next.name, next.mode)) break;
      queue.shift();
      next.settled = true;
      next.start();
    }
  };

  const request = (
    name: string,
    optionsOrCallback: unknown,
    maybeCallback?: (lock: Lock | null) => unknown,
  ): Promise<unknown> => {
    const options = (
      typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    ) as LockOptions;
    const callback = (
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback
    ) as (lock: Lock | null) => unknown;

    const modeIn = options?.mode ?? 'exclusive';
    if (!MODES.includes(modeIn))
      return Promise.reject(
        new TypeError(`'${String(modeIn)}' is not a valid LockMode`),
      );
    if (options?.ifAvailable && options.signal)
      return Promise.reject(
        new DOMException('ifAvailable with signal', 'NotSupportedError'),
      );
    const mode = modeIn as Mode;
    const signal = options?.signal ?? undefined;
    if (signal?.aborted)
      return Promise.reject(new DOMException('aborted', 'AbortError'));

    return new Promise<unknown>((resolve, reject) => {
      const run = (lock: Lock | null, release?: () => void) =>
        queueMicrotask(() => {
          let result: unknown;
          try {
            result = callback(lock);
          } catch (err) {
            release?.();
            reject(err);
            return;
          }
          Promise.resolve(result).then(
            (value) => {
              release?.();
              resolve(value);
            },
            (err) => {
              release?.();
              reject(err);
            },
          );
        });

      const req: Request = {
        name,
        mode,
        signal,
        settled: false,
        start: () => run({ name, mode } as Lock, acquire(name, mode)),
        fail: reject,
      };

      queueMicrotask(() => {
        if (signal?.aborted) {
          req.settled = true;
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const queue = queueOf(name);
        if (options?.ifAvailable) {
          req.settled = true;
          if (queue.length || !compatible(name, mode)) run(null);
          else req.start();
          return;
        }
        queue.push(req);
        signal?.addEventListener('abort', () => {
          if (req.settled) return;
          req.settled = true;
          const idx = queue.indexOf(req);
          if (idx >= 0) queue.splice(idx, 1);
          req.fail(new DOMException('aborted', 'AbortError'));
          pump(name);
        });
        pump(name);
      });
    });
  };

  return { request } as unknown as LockManager;
}

/** A LockManager whose every request rejects, as in an opaque-origin document. */
export function createRejectingLocks(): LockManager {
  return {
    request: () =>
      Promise.reject(new DOMException('opaque origin', 'SecurityError')),
  } as unknown as LockManager;
}

/** An in-memory BroadcastChannel hub: a message reaches every other connected channel. */
export function createFakeChannelHub() {
  const channels = new Set<MutationSyncChannel>();
  return {
    connect(): MutationSyncChannel {
      const channel: MutationSyncChannel = {
        onmessage: null,
        postMessage(message: unknown) {
          for (const other of channels)
            if (other !== channel)
              other.onmessage?.({ data: message } as MessageEvent);
        },
        close() {
          channels.delete(channel);
        },
      };
      channels.add(channel);
      return channel;
    },
  };
}
