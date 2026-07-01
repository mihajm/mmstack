import { inject, InjectionToken, type Signal } from '@angular/core';
import { type SignalStore } from './types';

export const IS_STORE = Symbol('@mmstack/primitives::store/IS_STORE');
export const SCOPE_PARENT = Symbol('@mmstack/primitives::store/SCOPE_PARENT');
export const STORE_SHARED_GLOBALS = Symbol(
  '@mmstack/primitives::store/STORE_SHARED_GLOBALS',
);
export const STORE_SHARED_OPTIONS = Symbol(
  '@mmstack/primitives::store/STORE_SHARED_OPTIONS',
);

/**
 * @internal Brand carrying a store's writability ('mutable' | 'writable' | 'readonly'), stamped
 * on every store proxy. Read by `extendStore` instead of re-deriving via `isWritableSignal`,
 * which would mis-classify a readonly scoped store (its backing `toWritable` still has a `set`).
 */
export const STORE_KIND = Symbol('@mmstack/primitives::store/STORE_KIND');

export type StoreKind = 'mutable' | 'writable' | 'readonly';

export const SIGNAL_FN_PROP = new Set([
  'set',
  'update',
  'mutate',
  'inline',
  'asReadonly',
]);

/**
 * @internal
 * Maps a store's backing signal to its lazily-built child proxies, each held via a `WeakRef`.
 */
export type ProxyCache = WeakMap<
  object,
  Map<PropertyKey, WeakRef<Signal<any>>>
>;

/**
 * @internal
 * Prunes a cache entry once its proxy is reclaimed by the GC.
 */
export type ProxyCleanupRegistry = FinalizationRegistry<{
  target: object;
  prop: PropertyKey;
}>;

export const PROXY_CACHE_TOKEN = new InjectionToken<ProxyCache>(
  '@mmstack/primitives:store-proxy-cache',
  {
    providedIn: 'root',
    factory: () => new WeakMap(),
  },
);

export const PROXY_CLEANUP_TOKEN = new InjectionToken<ProxyCleanupRegistry>(
  '@mmstack/primitives:store-proxy-cleanup',
  {
    providedIn: 'root',
    factory: () => {
      const cache = inject(PROXY_CACHE_TOKEN);
      return new FinalizationRegistry(({ target, prop }) => {
        const store = cache.get(target);
        if (store) store.delete(prop);
      });
    },
  },
);

/**
 * @internal
 * Validates whether a value is a Signal Store.
 */
export function isStore<T>(value: unknown): value is SignalStore<T> {
  return (
    typeof value === 'function' &&
    value !== null &&
    (value as any)[IS_STORE] === true
  );
}
