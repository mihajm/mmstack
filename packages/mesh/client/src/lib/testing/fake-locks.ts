export const LOCK = (key: string) => `@mmstack/mesh:outbox:${key}`;

/**
 * A faithful in-process Web Locks stand-in: exclusive, FIFO-queued, `AbortSignal`-cancelable, and
 * `ifAvailable` (the callback gets `null` at once when the lock is held or already queued for).
 * Shared by every spec that contends for the outbox lock.
 */
export function installFakeLocks() {
  const held = new Set<string>();
  const waiters = new Map<string, { run: () => void; entry: symbol }[]>();
  let requests = 0;
  let grants = 0;

  const pump = (name: string): void => {
    if (held.has(name)) return;
    const q = waiters.get(name);
    if (!q || q.length === 0) return;
    q.shift()?.run();
  };

  const request = (
    name: string,
    options: { mode?: string; signal?: AbortSignal; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    requests++;
    if (options.ifAvailable && options.signal) {
      // the Web Locks API rejects this combination
      return Promise.reject(
        new DOMException('ifAvailable with signal', 'NotSupportedError'),
      );
    }
    if (
      options.ifAvailable &&
      (held.has(name) || (waiters.get(name)?.length ?? 0) > 0)
    ) {
      return Promise.resolve().then(() => callback(null)); // not granted, never queued
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const entry = Symbol();
      const run = (): void => {
        if (done) return;
        held.add(name);
        grants++;
        Promise.resolve(
          callback({ name, mode: options.mode ?? 'exclusive' }),
        ).then(
          (v) => {
            done = true;
            held.delete(name);
            resolve(v);
            pump(name);
          },
          (e) => {
            done = true;
            held.delete(name);
            reject(e);
            pump(name);
          },
        );
      };
      const q = waiters.get(name) ?? [];
      q.push({ run, entry });
      waiters.set(name, q);
      const onAbort = (): void => {
        const arr = waiters.get(name);
        const i = arr?.findIndex((w) => w.entry === entry) ?? -1;
        if (i >= 0 && !done) {
          arr?.splice(i, 1);
          done = true;
          reject(new DOMException('aborted', 'AbortError'));
        }
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort);
      pump(name);
    });
  };

  const nav = globalThis.navigator as unknown as { locks?: unknown };
  const prev = Object.getOwnPropertyDescriptor(nav, 'locks');
  Object.defineProperty(nav, 'locks', {
    value: { request },
    configurable: true,
  });

  return {
    held,
    requests: () => requests,
    grants: () => grants,
    restore: () => {
      if (prev) Object.defineProperty(nav, 'locks', prev);
      else delete nav.locks;
    },
  };
}
