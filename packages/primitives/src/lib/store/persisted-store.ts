import { isPlatformServer } from '@angular/common';
import {
  DestroyRef,
  effect,
  inject,
  InjectionToken,
  Injector,
  isDevMode,
  PLATFORM_ID,
  signal,
  untracked,
  type CreateSignalOptions,
  type Provider,
  type Signal,
} from '@angular/core';
import { store, type toStoreOptions } from './store';
import type { WritableSignalStore } from './types';

type MaybePromise<T> = T | Promise<T>;

/**
 * The minimal async key/value contract persistence needs. Deliberately matches `idb-keyval`'s
 * top-level `get`/`set`/`del` so its module drops in with no wrapper (`persist(s, { key, store:
 * idbKeyval })`). Any store backed by structured clone (idb-keyval, Dexie) can hold complex values
 * without a serialize hook. A Dexie table needs a tiny adapter because it names things differently:
 *
 * ```ts
 * const table = db.table<{ key: string; value: unknown }>('kv');
 * const asyncStore: AsyncStore = {
 *   get: (k) => table.get(k).then((r) => r?.value),
 *   set: (k, v) => table.put({ key: k, value: v }).then(() => undefined),
 *   del: (k) => table.delete(k),
 * };
 * ```
 */
export type AsyncStore = {
  get(key: string): MaybePromise<unknown>;
  set(key: string, value: unknown): MaybePromise<void>;
  del(key: string): MaybePromise<void>;
};

/** Persistence options — the reader-side settings, independent of how the store was created. */
export type PersistOptions<T> = {
  /** Storage key for this store's snapshot. Required per call. */
  readonly key: string;
  /** The async backend. Falls back to the provided default (see {@link providePersistedStoreOptions}). */
  readonly store?: AsyncStore;
  /** Encode before writing. Default identity: structured-clone backends keep complex values. */
  readonly serialize?: (value: T) => unknown;
  /** Decode after reading. Default identity. */
  readonly deserialize?: (raw: unknown) => T;
  /**
   * Current schema version of the persisted value. When set, snapshots are written wrapped in a
   * small version envelope, and a snapshot stamped with an older version is passed through
   * {@link PersistOptions.migrate} on boot before it is adopted. A snapshot from a *newer* version
   * than this build is left untouched (a newer client wrote it).
   */
  readonly version?: number;
  /**
   * Bring a snapshot from an older `version` up to the current shape. It runs during boot, which
   * is already async, so it may be async too: lazy-import the migration ladder here and only pay
   * for it when there is old data to migrate. Receives the decoded old value and the version it
   * was written with (`0` for a pre-versioning snapshot).
   */
  readonly migrate?: (data: unknown, fromVersion: number) => MaybePromise<T>;
  /** Coalesce writes by this many ms (default 300). A flush/teardown always writes immediately. */
  readonly writeDebounceMs?: number;
  readonly injector?: Injector;
};

export type PersistedStoreOptions<T extends object> = CreateSignalOptions<T> &
  toStoreOptions &
  PersistOptions<T>;

/**
 * App-wide defaults for {@link persist} / {@link persistedStore}. Only cross-type settings live
 * here; `serialize`/`deserialize` are per-call because they depend on the store's value type.
 */
export type PersistedStoreDefaults = {
  readonly store?: AsyncStore;
  readonly writeDebounceMs?: number;
};

export const PERSISTED_STORE_OPTIONS =
  new InjectionToken<PersistedStoreDefaults>(
    '@mmstack/primitives:persisted-store-options',
  );

/**
 * Wire the {@link AsyncStore} backend (and any shared debounce) once, override per call. The
 * typical use is to install idb-keyval at bootstrap so every `persist`/`persistedStore` persists
 * without re-passing the backend.
 *
 * @example
 * import * as idbKeyval from 'idb-keyval';
 * providePersistedStoreOptions({ store: idbKeyval });
 */
export function providePersistedStoreOptions(
  opt: PersistedStoreDefaults,
): Provider {
  return { provide: PERSISTED_STORE_OPTIONS, useValue: opt };
}

/** Persistence controls for a store, from {@link persist}. */
export type PersistHandle = {
  /**
   * `false` until the first read from the backend settles (or immediately `true` on the server
   * and when no backend is configured). Gate first paint on it if a stale-flash matters.
   */
  readonly hydrated: Signal<boolean>;
  /** Force any pending debounced write to the backend now. */
  flush(): Promise<void>;
  /** Remove the snapshot from the backend and reset the store to the value it held when attached. */
  clear(): Promise<void>;
};

/**
 * A store plus its persistence controls. Shaped like {@link Fork} (a `.store` field, not the
 * store itself) because the store is a proxy where any property access resolves a child path,
 * so controls cannot live on it directly.
 */
export type PersistedStore<T extends object> = {
  /** The live store. Reads are synchronous; it holds the initial value until hydration lands. */
  readonly store: WritableSignalStore<T>;
} & PersistHandle;

/**
 * Attach durable local persistence to an EXISTING store: its whole-value snapshot is written to an
 * async backend (IndexedDB via idb-keyval or Dexie) and restored on boot. A reader over the store,
 * so it composes with the other op-log readers (`tabSync`, `@mmstack/mesh`) on the same store — a
 * persisted, synced graph is just two readers. Local durability, not sync.
 *
 * Because the backend is async, hydration cannot precede the first read: the store keeps its current
 * value, then adopts the persisted snapshot once the backend answers, UNLESS a write happened first
 * (an explicit boot-time write wins over stale disk). Writes are coalesced and flushed on teardown
 * and on page hide, so the last change is never lost. On the server it is a no-op.
 *
 * When the persisted shape evolves, pass `version` and a `migrate` hook: an older snapshot is
 * brought forward on boot before it is adopted, then re-persisted in the new shape. Because boot is
 * already async, `migrate` may be async, so the migration ladder can be lazy-imported.
 */
export function persist<T extends object>(
  source: WritableSignalStore<T>,
  opt: PersistOptions<T>,
): PersistHandle {
  const injector = opt.injector ?? inject(Injector);
  const defaults = injector.get(PERSISTED_STORE_OPTIONS, null);

  const key = opt.key;
  const backend = opt.store ?? defaults?.store;
  const serialize = opt.serialize ?? ((v: T) => v as unknown);
  const deserialize = opt.deserialize ?? ((r: unknown) => r as T);
  const version = opt.version;
  const debounceMs = opt.writeDebounceMs ?? defaults?.writeDebounceMs ?? 300;

  const read = source as unknown as () => T;
  const setRoot = (value: T): void =>
    (source as unknown as { set(v: T): void }).set(value);

  const VERSION_KEY = '__mmstack_pv';
  const encode = (value: T): unknown =>
    version === undefined
      ? serialize(value)
      : { [VERSION_KEY]: version, data: serialize(value) };

  const isServer = isPlatformServer(injector.get(PLATFORM_ID));
  const initialRef = untracked(read); // copy-on-write: an untouched store keeps this reference
  const hydrated = signal(false);

  if (isServer || !backend) {
    if (!backend && !isServer && isDevMode()) {
      console.warn(
        `[@mmstack/primitives] persist("${key}"): no AsyncStore backend (pass { store } or providePersistedStoreOptions). Running in-memory, not persisted.`,
      );
    }
    hydrated.set(true);
    return {
      hydrated: hydrated.asReadonly(),
      flush: () => Promise.resolve(),
      clear: () => {
        setRoot(initialRef);
        return Promise.resolve();
      },
    };
  }

  let persistedRef: T = initialRef;

  void (async () => {
    try {
      const raw = await backend.get(key);
      // apply the snapshot only if nothing wrote in the boot window (explicit write wins)
      if (raw !== undefined && raw !== null && untracked(read) === initialRef) {
        let fromVersion = 0;
        let payload: unknown = raw;
        if (
          typeof raw === 'object' &&
          raw !== null &&
          VERSION_KEY in (raw as Record<string, unknown>)
        ) {
          const env = raw as Record<string, unknown>;
          fromVersion =
            typeof env[VERSION_KEY] === 'number'
              ? (env[VERSION_KEY] as number)
              : 0;
          payload = env['data'];
        }
        const target = version ?? 0;
        if (fromVersion > target) {
          if (isDevMode()) {
            console.warn(
              `[@mmstack/primitives] persist("${key}"): stored snapshot is version ${fromVersion} but this build is ${target}; leaving it untouched (a newer build wrote it).`,
            );
          }
        } else {
          const migrated = !!(opt.migrate && fromVersion < target);
          let value = deserialize(payload);
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          if (migrated) value = await opt.migrate!(value, fromVersion);
          if (untracked(read) === initialRef) {
            setRoot(value);
            if (!migrated) persistedRef = value;
          }
        }
      }
    } catch (err) {
      if (isDevMode()) {
        console.warn(
          `[@mmstack/primitives] persist("${key}") hydrate failed`,
          err,
        );
      }
    } finally {
      hydrated.set(true);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = async (value: T): Promise<void> => {
    try {
      await backend.set(key, encode(value));
      persistedRef = value;
    } catch (err) {
      if (isDevMode()) {
        console.warn(
          `[@mmstack/primitives] persist("${key}") write failed`,
          err,
        );
      }
    }
  };

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = async (): Promise<void> => {
    cancelTimer();
    const current = untracked(read);
    if (
      !untracked(hydrated) ||
      current === initialRef ||
      current === persistedRef
    )
      return;
    await write(current);
  };

  effect(
    () => {
      if (!hydrated()) return;
      const value = read();
      untracked(() => {
        cancelTimer();
        // untouched / reset-to-initial, or already the value on disk (e.g. just hydrated): skip
        if (value === initialRef || value === persistedRef) return;
        timer = setTimeout(() => {
          timer = undefined;
          void write(value);
        }, debounceMs);
      });
    },
    { injector },
  );

  const onHide = (): void => {
    void flush();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
  }

  injector.get(DestroyRef).onDestroy(() => {
    void flush();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    }
  });

  return {
    hydrated: hydrated.asReadonly(),
    flush,
    clear: async () => {
      cancelTimer();
      setRoot(initialRef); // back to initialRef, so the persist effect skips (no re-write over the delete)
      persistedRef = initialRef; // disk is now empty
      try {
        await backend.del(key);
      } catch (err) {
        if (isDevMode()) {
          console.warn(
            `[@mmstack/primitives] persist("${key}") clear failed`,
            err,
          );
        }
      }
    },
  };
}

/**
 * A `store` with {@link persist} already attached: a whole-value snapshot persisted to an async
 * backend and restored on boot. Equivalent to `const s = store(initial); persist(s, opt)` — reach
 * for `persist` directly when you want persistence on a store you already have (e.g. to also
 * `meshSync` it).
 */
export function persistedStore<T extends object>(
  initial: T,
  opt: PersistedStoreOptions<T>,
): PersistedStore<T> {
  const injector = opt.injector ?? inject(Injector);
  // store() reads only the signal/store opts it knows; the persistence keys ride along harmlessly
  const s = store(initial, { ...opt, injector }) as WritableSignalStore<T>;
  const handle = persist(s, { ...opt, injector });
  return { store: s, ...handle };
}
