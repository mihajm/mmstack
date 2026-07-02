import {
  computed,
  inject,
  Injector,
  isSignal,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from '../derived';
import { isMutable, mutable, type MutableSignal } from '../mutable';
import { toWritable } from '../to-writable';
import { createVivify, isIndexProp, type Vivify } from '../util';
import {
  IS_STORE,
  isStore,
  PROXY_CACHE_TOKEN,
  PROXY_CLEANUP_TOKEN,
  SCOPE_PARENT,
  SIGNAL_FN_PROP,
  STORE_KIND,
  STORE_SHARED_GLOBALS,
  STORE_SHARED_OPTIONS,
  type ProxyCache,
  type ProxyCleanupRegistry,
  type StoreKind,
} from './internals';
import { markAsLeaf } from './leaf';
import { isOpaque } from './opaque';
import {
  createFallbackOnChange,
  hasOwnKey,
  isRecord,
  isWritableSignal,
  resolveVivify,
} from './predicates';
import {
  type AnyRecord,
  type Key,
  type MutableSignalStore,
  type SignalStore,
  type Simplify,
  type WritableSignalStore,
} from './types';

export type toStoreOptions = {
  injector?: Injector;
  /**
   * Opt-in autovivification: when writing through a `null`/`undefined` path, create the
   * missing intermediate containers instead of dropping the write. Off by default.
   *
   * Levels whose current value is a known object/array re-vivify as that same shape — the
   * knowledge is captured when the path is first accessed and cached, so it holds even after
   * the value is later nulled. This option governs only genuinely-unknown (currently
   * `null`/`undefined`) levels: `'auto'` (an array for index keys, an object otherwise), an
   * explicit `'object'`/`'array'`, or a `() => container` factory. See {@link Vivify}.
   */
  vivify?: Vivify;
  /**
   * Performance opt-in: promise that no node ever switches between leaf and substore (i.e. no
   * unions mixing a primitive with an object/array). With this on, each node's leaf-ness is
   * resolved once on the first {@link isLeaf} probe and cached as a constant, skipping the
   * reactive `computed`. If a node's shape does change anyway, {@link isLeaf} keeps its first
   * answer. Off by default.
   */
  noUnionLeaves?: boolean;
  /**
   * @internal
   * Shared cleanup singletons, they get injected/passed automatically
   */
  [STORE_SHARED_GLOBALS]?: {
    cache: ProxyCache;
    registry: ProxyCleanupRegistry;
  };
};

export type StoreOptions<T> = CreateSignalOptions<T> & toStoreOptions;

/**
 * @internal Reads (or lazily builds + caches) the child node proxy for `prop` on `target`,
 * holding it via a `WeakRef` and registering it for finalizer-driven cache pruning. The cache
 * is keyed per backing signal, so child identity is stable across repeat reads.
 */
function getCachedChild(
  target: object,
  prop: PropertyKey,
  build: () => Signal<any>,
  cache: ProxyCache,
  cleanupRegistry: ProxyCleanupRegistry,
): Signal<any> {
  let storeCache = cache.get(target);
  if (!storeCache) {
    storeCache = new Map();
    cache.set(target, storeCache);
  }

  const cachedRef = storeCache.get(prop);
  if (cachedRef) {
    const cached = cachedRef.deref();
    if (cached) return cached;
    storeCache.delete(prop);
    cleanupRegistry.unregister(cachedRef);
  }

  const proxy = build();
  const ref = new WeakRef(proxy);
  storeCache.set(prop, ref);
  cleanupRegistry.register(proxy, { target, prop }, ref);
  return proxy;
}

/**
 * @internal Whether a mutable parent's child value must always re-notify: in-place mutation
 * keeps an object child's reference stable, so `Object.is` would swallow the change. Decided
 * per-VALUE (not snapshotted at build) so a union child that becomes an object later still
 * propagates parent-level mutations.
 */
function mutableChildEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' && a !== null) return false;
  return Object.is(a, b);
}

/**
 * @internal Builds the derived child signal for `prop` and wraps it as an array/object substore.
 * Both the read (`v?.[prop]`) and the write (`createFallbackOnChange` copies by the container's
 * LIVE shape) are shape-adaptive, so a child cached before an array↔record↔null union flip stays
 * correct after it. The only place a child node is constructed — shared by every container kind.
 */
function buildChildNode(
  target: WritableSignal<any> | MutableSignal<any>,
  prop: Key,
  isMutableSource: boolean,
  options: Required<toStoreOptions>,
): Signal<any> {
  const value = untracked(target);

  const nodeVivify = resolveVivify(value, options.vivify);
  const vivifyFn = createVivify(nodeVivify);

  const equalFn =
    isMutableSource && (isRecord(value) || Array.isArray(value))
      ? mutableChildEqual
      : undefined;

  const computation = derived(target, {
    from: (v: any) => v?.[prop],
    onChange: createFallbackOnChange(target, prop, vivifyFn, isMutableSource),
    equal: equalFn,
  });

  const childSample = untracked(computation);
  const childVivify = resolveVivify(childSample, options.vivify);
  const proxy = toStore(computation, options);

  markAsLeaf(proxy, computation, childVivify !== false, options.noUnionLeaves);
  return proxy;
}

export function toStore<T extends AnyRecord>(
  source: MutableSignal<T>,
  options?: toStoreOptions,
): MutableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: WritableSignal<T>,
  options?: toStoreOptions,
): WritableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: Signal<T>,
  options?: toStoreOptions,
): SignalStore<T>;

/**
 * Converts a Signal into a deep-observable Store.
 * Accessing nested properties returns a derived Signal of that path.
 *
 * @remarks
 * A node's *container kind* (array / record / primitive) is tracked reactively via a per-node
 * `kind` computed, so the same proxy serves all three and a union node that flips between an
 * array and a record keeps working. Flips are route-forward: after a flip the node behaves as
 * its new kind on the next access, while child proxies cached under the old shape go stale and
 * are pruned by the GC.
 *
 * @example
 * const state = store({ user: { name: 'John' } });
 * const nameSignal = state.user.name; // WritableSignal<string>
 */
export function toStore<T extends AnyRecord>(
  source: Signal<T> | WritableSignal<T> | MutableSignal<T>,
  {
    injector,
    vivify = false,
    noUnionLeaves = false,
    ...rest
  }: toStoreOptions = {},
): SignalStore<T> | WritableSignalStore<T> | MutableSignalStore<T> {
  if (isStore<T>(source)) return source;

  if (!injector) injector = inject(Injector);

  const writableSource = isWritableSignal(source)
    ? source
    : toWritable(source, () => {
        // noop
      });

  const isWritableSource = isWritableSignal(source);
  const isMutableSource = isWritableSource && isMutable(writableSource);

  const kind = computed<'array' | 'record' | 'primitive'>(() => {
    const v = source();
    if (Array.isArray(v) && !isOpaque(v)) return 'array';
    if (isRecord(v)) return 'record';
    return 'primitive';
  });

  const STORE_OPTIONS: Required<toStoreOptions> = {
    injector,
    vivify,
    noUnionLeaves,
    [STORE_SHARED_GLOBALS]: {
      cache:
        rest[STORE_SHARED_GLOBALS]?.cache ?? injector.get(PROXY_CACHE_TOKEN),
      registry:
        rest[STORE_SHARED_GLOBALS]?.registry ??
        injector.get(PROXY_CLEANUP_TOKEN),
    },
  };

  // built lazily so non-array nodes never allocate it
  let length: Signal<number> | undefined;
  const arrayLength = () =>
    (length ??= computed(() => {
      const v = source();
      return Array.isArray(v) ? v.length : 0;
    }));

  const s = new Proxy(writableSource, {
    has(_: any, prop) {
      const v = untracked(source) as any;
      if (untracked(kind) === 'array') {
        if (prop === 'length') return true;
        if (isIndexProp(prop)) {
          const idx = +prop;
          return idx >= 0 && idx < v.length;
        }
      }
      // nullish node values are routinely descended with vivify on — `in` must not throw
      return v == null ? false : Reflect.has(v, prop);
    },
    ownKeys() {
      const v = untracked(source) as any;
      if (untracked(kind) === 'array') {
        const len = v.length;
        const arr = new Array(len + 1);
        for (let i = 0; i < len; i++) arr[i] = String(i);
        arr[len] = 'length';
        return arr;
      }
      if (!isRecord(v)) return [];
      return Reflect.ownKeys(v);
    },
    getPrototypeOf() {
      if (untracked(kind) === 'array') return Array.prototype;
      const v = untracked(source) as any;
      return v == null ? Object.prototype : Object.getPrototypeOf(v);
    },
    getOwnPropertyDescriptor(_, prop) {
      const v = untracked(source) as any;
      if (untracked(kind) === 'array') {
        if (
          prop === 'length' ||
          (typeof prop === 'string' && !isNaN(+prop) && +prop < v.length)
        )
          return { enumerable: true, configurable: true };
        return;
      }
      if (!isRecord(v) || !(prop in v)) return;
      return { enumerable: true, configurable: true };
    },
    get(target: any, prop, receiver) {
      if (typeof prop === 'symbol') {
        if (prop === IS_STORE) return true;
        if (prop === STORE_KIND)
          return isMutableSource
            ? 'mutable'
            : isWritableSource
              ? 'writable'
              : 'readonly';
        if (prop === STORE_SHARED_OPTIONS) return STORE_OPTIONS;
      }

      if (prop === 'asReadonlyStore')
        return () => {
          if (!isWritableSource) return s;
          return untracked(() =>
            toStore(source.asReadonly(), { injector, vivify, noUnionLeaves }),
          );
        };

      const k = untracked(kind);

      if (prop === 'extend' && k !== 'array')
        return (seed: AnyRecord | Signal<AnyRecord>) =>
          scopedStore(
            s,
            seed,
            isMutableSource
              ? 'mutable'
              : isWritableSource
                ? 'writable'
                : 'readonly',
            STORE_OPTIONS,
          );

      if (k === 'array') {
        if (prop === 'length') return arrayLength();
        if (prop === Symbol.iterator)
          return function* () {
            // read length reactively: a spread/for-of inside a computed/effect must re-run
            // when items are added or removed, not only when already-read elements change
            const len = arrayLength();
            for (let i = 0; i < len(); i++) yield receiver[i];
          };
      }

      if (typeof prop === 'symbol' || SIGNAL_FN_PROP.has(prop))
        return target[prop];

      if (k === 'array' && !isIndexProp(prop))
        return Reflect.get(target, prop, receiver);

      return getCachedChild(
        target,
        prop,
        () =>
          buildChildNode(
            target,
            k === 'array' ? +(prop as string) : (prop as Key),
            isMutableSource,
            STORE_OPTIONS,
          ),
        STORE_OPTIONS[STORE_SHARED_GLOBALS].cache,
        STORE_OPTIONS[STORE_SHARED_GLOBALS].registry,
      );
    },
  });

  return s;
}

type ScopeKind = 'mutable' | 'writable' | 'readonly';

/**
 * @internal
 * Backs `extendStore(...)`. Builds a scoped overlay over `parent`: the local layer (the seed
 * plus any keys created later) is its own signal and `parent` is its own signal, so the getter
 * routes each key by consulting BOTH — local first, then parent, else local (so a write to an
 * as-yet-unknown key lands locally). Inherited keys return the parent's own sub-store (shared
 * identity + two-way), while local keys never propagate upward. A merged `computed` is derived
 * only for whole-object reads / `has` / iteration — never for routing.
 */
function scopedStore(
  parent: SignalStore<AnyRecord>,
  seed: AnyRecord | Signal<AnyRecord>,
  kind: ScopeKind,
  options: Required<toStoreOptions>,
): SignalStore<AnyRecord> {
  const local = isSignal(seed)
    ? toStore(seed as Signal<AnyRecord>, options)
    : kind === 'mutable'
      ? mutableStore(seed, options)
      : kind === 'readonly'
        ? store(seed, options).asReadonlyStore()
        : store(seed, options);

  const localValue = () => untracked(local) as object;
  const parentValue = () => untracked(parent) as object;

  const view = computed(() => ({
    ...parent(),
    ...local(),
  }));

  const splitSet = (next: AnyRecord) => {
    const lv = localValue();
    const pv = parentValue();
    for (const key of Reflect.ownKeys(next)) {
      const layer = hasOwnKey(lv, key)
        ? local
        : hasOwnKey(pv, key)
          ? parent
          : local;
      (layer as WritableSignalStore<AnyRecord>)[key as string].set(
        next[key as string],
      );
    }
  };

  const base = toWritable(
    view,
    kind === 'readonly' ? () => undefined : splitSet,
    undefined,
    {
      pure: false,
    },
  ) as MutableSignal<AnyRecord>;

  if (kind === 'mutable') {
    base.mutate = (updater: (v: any) => any) =>
      splitSet(updater(untracked(view)));
    base.inline = (updater: (v: any) => void) =>
      base.mutate((prev: any) => {
        updater(prev);
        return prev;
      });
  }

  const scope: any = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') {
        if (prop === IS_STORE) return true;
        if (prop === STORE_KIND) return kind;
        if (prop === SCOPE_PARENT) return parent;
        if (prop === STORE_SHARED_OPTIONS) return options;
      }
      if (prop === 'extend')
        return (childSeed: AnyRecord | Signal<AnyRecord>) =>
          scopedStore(scope, childSeed, kind, options);
      if (prop === 'asReadonlyStore')
        return () =>
          toStore(
            computed(() => ({ ...parent(), ...local() })),
            options,
          );
      if (typeof prop === 'symbol' || SIGNAL_FN_PROP.has(prop))
        return target[prop as keyof typeof target];

      // Route by consulting both signals: local first, then parent, else local (new → local).
      if (hasOwnKey(localValue(), prop)) return local[prop];
      if (hasOwnKey(parentValue(), prop)) return parent[prop];
      return local[prop];
    },
    has(_, prop) {
      return hasOwnKey(localValue(), prop) || hasOwnKey(parentValue(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(untracked(view));
    },
    getOwnPropertyDescriptor(_, prop) {
      if (hasOwnKey(localValue(), prop) || hasOwnKey(parentValue(), prop))
        return { enumerable: true, configurable: true };
      return undefined;
    },
    getPrototypeOf() {
      return Object.prototype;
    },
  });

  return scope;
}

/** @internal Reads a store's writability brand, falling back to signal inspection if unbranded. */
function storeKind(s: any): StoreKind {
  return (
    (s[STORE_KIND] as StoreKind | undefined) ??
    (isWritableSignal(s) ? (isMutable(s) ? 'mutable' : 'writable') : 'readonly')
  );
}

export type ExtendStoreOptions = Omit<
  toStoreOptions,
  'vivify' | 'noUnionLeaves' | typeof STORE_SHARED_GLOBALS
>;

export function extendStore<T extends AnyRecord, L extends AnyRecord>(
  store: MutableSignalStore<T>,
  source: MutableSignal<L> | L,
  options?: ExtendStoreOptions,
): MutableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
export function extendStore<T extends AnyRecord, L extends AnyRecord>(
  store: WritableSignalStore<T>,
  source: WritableSignal<L> | L,
  options?: ExtendStoreOptions,
): WritableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
export function extendStore<T extends AnyRecord, L extends AnyRecord>(
  store: SignalStore<T>,
  source: Signal<L> | L,
  options?: ExtendStoreOptions,
): SignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;

/**
 * Extends a store with extra keys via a scoped overlay, returning a new store that reads through
 * to the parent for inherited keys (shared identity + two-way) while holding the new keys locally.
 *
 * The typesafe successor to the deprecated `store.extend(...)` method — moving it off the proxy
 * frees the `extend` key for use as a normal record key. Writability (readonly/writable/mutable)
 * is inherited from `store`.
 *
 * @example
 * const base = store({ count: 0 });
 * const scoped = extendStore(base, { label: 'live' });
 * scoped.count.set(1); // writes through to base
 * scoped.label.set('x'); // stays local
 */
export function extendStore(
  store: SignalStore<AnyRecord>,
  source: AnyRecord | Signal<AnyRecord>,
  options?: ExtendStoreOptions,
): SignalStore<AnyRecord> {
  const opt: Required<toStoreOptions> = {
    ...(store as any)[STORE_SHARED_OPTIONS],
    ...options,
  };

  return scopedStore(store, source, storeKind(store), opt);
}

/**
 * Creates a WritableSignalStore from a value.
 * @see {@link toStore}
 */
export function store<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T> & {
    injector?: Injector;
    /**
     * Opt-in autovivification: when writing through a `null`/`undefined` path, create the
     * missing intermediate containers instead of dropping the write. Off by default.
     *
     * Levels whose current value is a known object/array re-vivify as that same shape — the
     * knowledge is captured when the path is first accessed and cached, so it holds even after
     * the value is later nulled. This option governs only genuinely-unknown (currently
     * `null`/`undefined`) levels: `'auto'` (an array for index keys, an object otherwise), an
     * explicit `'object'`/`'array'`, or a `() => container` factory. See {@link Vivify}.
     */
    vivify?: Vivify;
    /**
     * Performance opt-in: promise that no node ever switches between leaf and substore (i.e. no
     * unions mixing a primitive with an object/array). With this on, each node's leaf-ness is
     * resolved once on the first {@link isLeaf} probe and cached as a constant, skipping the
     * reactive `computed`. If a node's shape does change anyway, {@link isLeaf} keeps its first
     * answer. Off by default.
     */
    noUnionLeaves?: boolean;
  },
): WritableSignalStore<T> {
  return toStore(signal(value, opt), {
    vivify: false,
    noUnionLeaves: false,
    ...opt,
  });
}

/**
 * Creates a MutableSignalStore from a value.
 * @see {@link toStore}
 */
export function mutableStore<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T> & {
    injector?: Injector;
    /**
     * Opt-in autovivification: when writing through a `null`/`undefined` path, create the
     * missing intermediate containers instead of dropping the write. Off by default.
     *
     * Levels whose current value is a known object/array re-vivify as that same shape — the
     * knowledge is captured when the path is first accessed and cached, so it holds even after
     * the value is later nulled. This option governs only genuinely-unknown (currently
     * `null`/`undefined`) levels: `'auto'` (an array for index keys, an object otherwise), an
     * explicit `'object'`/`'array'`, or a `() => container` factory. See {@link Vivify}.
     */
    vivify?: Vivify;
    /**
     * Performance opt-in: promise that no node ever switches between leaf and substore (i.e. no
     * unions mixing a primitive with an object/array). With this on, each node's leaf-ness is
     * resolved once on the first {@link isLeaf} probe and cached as a constant, skipping the
     * reactive `computed`. If a node's shape does change anyway, {@link isLeaf} keeps its first
     * answer. Off by default.
     */
    noUnionLeaves?: boolean;
  },
): MutableSignalStore<T> {
  return toStore(mutable(value, opt), {
    vivify: false,
    noUnionLeaves: false,
    ...opt,
  });
}
