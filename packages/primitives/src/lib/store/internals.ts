import { type Signal } from '@angular/core';
import { type SignalStore } from './types';

export const IS_STORE = Symbol('@mmstack/primitives::store/IS_STORE');
export const SCOPE_PARENT = Symbol('@mmstack/primitives::store/SCOPE_PARENT');

/**
 * @internal Brand carrying a store's writability ('mutable' | 'writable' | 'readonly'), stamped
 * on every store proxy. Read by `extendStore` instead of re-deriving via `isWritableSignal`,
 * which would mis-classify a readonly scoped store (its backing `toWritable` still has a `set`).
 */
export const STORE_KIND = Symbol('@mmstack/primitives::store/STORE_KIND');

export type StoreKind = 'mutable' | 'writable' | 'readonly';

/**
 * @internal Brand exposing the injector a store was built with, so `extendStore` inherits it the
 * same way `store.extend(...)` does (via closure) — no injection context needed at the call site.
 */
export const STORE_INJECTOR = Symbol('@mmstack/primitives::store/STORE_INJECTOR');

export const SIGNAL_FN_PROP = new Set([
  'set',
  'update',
  'mutate',
  'inline',
  'asReadonly',
]);

/**
 * @internal
 * Test-only handle on the proxy cache (deliberately NOT re-exported from the public barrel).
 * Maps a store's backing signal to its lazily-built child proxies, each held via a `WeakRef`.
 */
export const PROXY_CACHE = new WeakMap<
  object,
  Map<PropertyKey, WeakRef<Signal<any>>>
>();

/**
 * @internal
 * Test-only handle on the finalization registry (deliberately NOT re-exported from the public
 * barrel). Prunes a cache entry once its proxy is reclaimed by the GC.
 */
export const PROXY_CLEANUP = new FinalizationRegistry<{
  target: object;
  prop: PropertyKey;
}>(({ target, prop }) => {
  const storeCache = PROXY_CACHE.get(target);
  if (storeCache) storeCache.delete(prop);
});

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
