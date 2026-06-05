import {
  computed,
  inject,
  Injector,
  isDevMode,
  isSignal,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from './derived';
import { isWritableSignal } from './mappers/util';
import { isMutable, mutable, type MutableSignal } from './mutable';
import { toWritable } from './to-writable';
import { createVivify, isIndexProp, type Vivify } from './util';

type BaseType =
  | string
  | number
  | boolean
  | symbol
  | undefined
  | null
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function
  | Date
  | RegExp;

type Key = string | number;

type AnyRecord = Record<Key, any>;

const IS_STORE = Symbol('MMSTACK::IS_STORE');
const SCOPE_PARENT = Symbol('MMSTACK::SCOPE_PARENT');

/**
 * @internal
 * Test-only handle on the proxy cache (deliberately NOT re-exported from the public barrel).
 * Maps a store's backing signal to its lazily-built child proxies, each held via a `WeakRef`.
 */
export const PROXY_CACHE = new WeakMap<
  object,
  Map<PropertyKey, WeakRef<Signal<any>>>
>();

const SIGNAL_FN_PROP = new Set([
  'set',
  'update',
  'mutate',
  'inline',
  'asReadonly',
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * @internal
 * Resolves the vivify shape for a node from its current value: a present record/array is a
 * certainty we keep (cached in the derivation, so it survives the value being nulled); an
 * unknown value (`null`/`undefined`) defers to the caller's option. Off stays off.
 */
function resolveVivify(sample: unknown, option: Vivify): Vivify {
  if (!option) return false;
  if (Array.isArray(sample)) return 'array';
  if (isRecord(sample)) return 'object';
  return 'auto';
}

function hasOwnKey(
  value: object | null | undefined,
  key: PropertyKey,
): boolean {
  return value != null && Object.hasOwn(value, key);
}

type SignalArrayStore<T extends any[]> = Signal<T> & {
  readonly [index: number]: SignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<SignalStore<T[number]>>;
};

type WritableArrayStore<T extends any[]> = WritableSignal<T> & {
  readonly asReadonlyStore: () => SignalArrayStore<T>;
  readonly [index: number]: WritableSignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<WritableSignalStore<T[number]>>;
};

type MutableArrayStore<T extends any[]> = MutableSignal<T> & {
  readonly asReadonlyStore: () => SignalArrayStore<T>;
  readonly [index: number]: MutableSignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<MutableSignalStore<T[number]>>;
};

function toArrayStore<T extends any[]>(
  source: MutableSignal<T>,
  injector: Injector,
  vivify: Vivify,
): MutableArrayStore<T>;
function toArrayStore<T extends any[]>(
  source: WritableSignal<T>,
  injector: Injector,
  vivify: Vivify,
): WritableArrayStore<T>;

/**
 * @internal
 * Makes an array store
 */
function toArrayStore<T extends any[]>(
  source: WritableSignal<T> | MutableSignal<T>,
  injector: Injector,
  vivify: Vivify,
): WritableArrayStore<T> | MutableArrayStore<T> {
  if (isStore<T>(source)) return source as unknown as MutableArrayStore<T>;

  const isMutableSource = isMutable(source);

  const lengthSignal = computed(() => {
    const v = source();
    if (!Array.isArray(v)) return 0;
    return v.length;
  });

  return new Proxy(source, {
    has(_, prop) {
      if (prop === 'length') return true;
      if (isIndexProp(prop)) {
        const idx = +prop;
        return idx >= 0 && idx < untracked(lengthSignal);
      }
      return Reflect.has(untracked(source), prop);
    },
    ownKeys() {
      const v = untracked(source);
      if (!Array.isArray(v)) return [];

      const len = v.length;
      const arr = new Array(len + 1);
      for (let i = 0; i < len; i++) {
        arr[i] = String(i);
      }
      arr[len] = 'length';

      return arr;
    },
    getPrototypeOf() {
      return Array.prototype;
    },
    getOwnPropertyDescriptor(_, prop) {
      const v = untracked(source);
      if (!Array.isArray(v)) return;

      if (
        prop === 'length' ||
        (typeof prop === 'string' && !isNaN(+prop) && +prop < v.length)
      ) {
        return {
          enumerable: true,
          configurable: true, // Required for proxies to dynamic targets
        };
      }

      return;
    },
    get(target, prop, receiver) {
      if (prop === IS_STORE) return true;
      if (prop === 'length') return lengthSignal;

      if (prop === Symbol.iterator) {
        return function* () {
          for (let i = 0; i < untracked(lengthSignal); i++) {
            yield receiver[i];
          }
        };
      }

      if (typeof prop === 'symbol' || SIGNAL_FN_PROP.has(prop))
        return (target as any)[prop];

      if (isIndexProp(prop)) {
        const idx = +prop;

        let storeCache = PROXY_CACHE.get(target);
        if (!storeCache) {
          storeCache = new Map();
          PROXY_CACHE.set(target, storeCache);
        }

        const cachedRef = storeCache.get(idx);
        if (cachedRef) {
          const cached = cachedRef.deref();
          if (cached) return cached;
          storeCache.delete(idx);
          PROXY_CLEANUP.unregister(cachedRef);
        }

        const value = untracked(target);
        const valueIsArray = Array.isArray(value);
        const valueIsRecord = isRecord(value);

        const nodeVivify = resolveVivify(value, vivify);
        const vivifyFn = createVivify(nodeVivify as Vivify);

        const equalFn =
          (valueIsRecord || valueIsArray) &&
          isMutableSource &&
          typeof (value as Record<string, any>)[idx] === 'object'
            ? () => false
            : undefined;

        const computation = valueIsRecord
          ? derived(target, idx as any, {
              equal: equalFn,
              vivify: nodeVivify as Vivify,
            })
          : derived(target, {
              from: (v: any) => v?.[idx],
              onChange: (newValue: any) =>
                target.update((v: any) => {
                  const container = vivifyFn(v, idx);
                  if (container === null || container === undefined)
                    return container;
                  try {
                    container[idx] = newValue;
                  } catch (e) {
                    if (isDevMode())
                      console.error(
                        `[store] Failed to set property "${String(idx)}"`,
                        e,
                      );
                  }
                  return container;
                }),
            });

        const childSample = untracked(computation);
        const childVivify = resolveVivify(childSample, vivify);
        const proxy = Array.isArray(childSample)
          ? toArrayStore(computation, injector, childVivify)
          : toStore(computation, injector, childVivify);

        const ref = new WeakRef(proxy);
        storeCache.set(idx, ref);
        PROXY_CLEANUP.register(proxy, { target, prop: idx }, ref);
        return proxy;
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as MutableArrayStore<T>;
}

/**
 * @internal Resolves to `true` only for `any`. In a conditional type, `any` distributes across
 * *both* branches (`unknown | object`), and `unknown | X` collapses to `unknown` — which would
 * erase a store's property access and `extend`. Guarding on this routes an `any`-typed store to
 * the full object shape instead.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * @internal Flattens an intersection (`A & B & C`) into a single object literal so editor
 * tooltips show the resolved members instead of the raw intersection chain. Display-only —
 * structurally identical to its input.
 */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** @internal The object shape of a readonly store: a child store per key, plus `extend`. */
type SignalStoreObject<T> = Simplify<
  Readonly<{
    [K in keyof Required<T>]: SignalStore<NonNullable<T>[K]>;
  }> & {
    readonly extend: {
      <L extends AnyRecord>(
        source: Signal<L>,
      ): SignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
      <L extends AnyRecord>(
        props: L,
      ): SignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
    };
  }
>;

/** @internal The object shape of a writable store. */
type WritableSignalStoreObject<T> = Simplify<
  Readonly<{
    [K in keyof Required<T>]: WritableSignalStore<NonNullable<T>[K]>;
  }> & {
    readonly extend: {
      <L extends AnyRecord>(
        source: WritableSignal<L>,
      ): WritableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
      <L extends AnyRecord>(
        props: L,
      ): WritableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
    };
  }
>;

/** @internal The object shape of a mutable store. */
type MutableSignalStoreObject<T> = Simplify<
  Readonly<{
    [K in keyof Required<T>]: MutableSignalStore<NonNullable<T>[K]>;
  }> & {
    readonly extend: {
      <L extends AnyRecord>(
        source: MutableSignal<L>,
      ): MutableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
      <L extends AnyRecord>(
        props: L,
      ): MutableSignalStore<Simplify<Omit<NonNullable<T>, keyof L> & L>>;
    };
  }
>;

export type SignalStore<T> = Signal<T> &
  (IsAny<T> extends true
    ? SignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? unknown
      : NonNullable<T> extends Array<any>
        ? SignalArrayStore<NonNullable<T>>
        : SignalStoreObject<T>);

export type WritableSignalStore<T> = WritableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (IsAny<T> extends true
    ? WritableSignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? unknown
      : NonNullable<T> extends Array<any>
        ? WritableArrayStore<NonNullable<T>>
        : WritableSignalStoreObject<T>);

export type MutableSignalStore<T> = MutableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (IsAny<T> extends true
    ? MutableSignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? unknown
      : NonNullable<T> extends Array<any>
        ? MutableArrayStore<NonNullable<T>>
        : MutableSignalStoreObject<T>);

export function toStore<T extends AnyRecord>(
  source: MutableSignal<T>,
  injector?: Injector,
  vivify?: Vivify,
): MutableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: WritableSignal<T>,
  injector?: Injector,
  vivify?: Vivify,
): WritableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: Signal<T>,
  injector?: Injector,
  vivify?: Vivify,
): SignalStore<T>;

/**
 * Converts a Signal into a deep-observable Store.
 * Accessing nested properties returns a derived Signal of that path.
 * @example
 * const state = store({ user: { name: 'John' } });
 * const nameSignal = state.user.name; // WritableSignal<string>
 */
export function toStore<T extends AnyRecord>(
  source: Signal<T> | WritableSignal<T> | MutableSignal<T>,
  injector?: Injector,
  vivify: Vivify = false,
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

  const s = new Proxy(writableSource, {
    has(_: any, prop) {
      return Reflect.has(untracked(source), prop);
    },
    ownKeys() {
      const v = untracked(source);
      if (!isRecord(v)) return [];
      return Reflect.ownKeys(v);
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(untracked(source));
    },
    getOwnPropertyDescriptor(_, prop) {
      const value = untracked(source);
      if (!isRecord(value) || !(prop in value)) return;
      return {
        enumerable: true,
        configurable: true,
      };
    },
    get(target: any, prop) {
      if (prop === IS_STORE) return true;
      if (prop === 'asReadonlyStore')
        return () => {
          if (!isWritableSource) return s;
          return untracked(() =>
            toStore(source.asReadonly(), injector, vivify),
          );
        };

      if (prop === 'extend')
        return (seed: AnyRecord | Signal<AnyRecord>) =>
          scopedStore(
            s,
            seed,
            isMutableSource
              ? 'mutable'
              : isWritableSource
                ? 'writable'
                : 'readonly',
            injector as Injector,
          );

      if (typeof prop === 'symbol' || SIGNAL_FN_PROP.has(prop))
        return target[prop];

      let storeCache = PROXY_CACHE.get(target);
      if (!storeCache) {
        storeCache = new Map();
        PROXY_CACHE.set(target, storeCache);
      }

      const cachedRef = storeCache.get(prop);
      if (cachedRef) {
        const cached = cachedRef.deref();
        if (cached) return cached;
        storeCache.delete(prop);
        PROXY_CLEANUP.unregister(cachedRef);
      }

      const value = untracked(target) as Record<string, any>;
      const valueIsRecord = isRecord(value);
      const valueIsArray = Array.isArray(value);

      const nodeVivify = resolveVivify(value, vivify);
      const vivifyFn = createVivify(nodeVivify);

      const equalFn =
        (valueIsRecord || valueIsArray) &&
        isMutableSource &&
        typeof (value as Record<string, any>)[prop] === 'object'
          ? () => false
          : undefined;
      const computation = valueIsRecord
        ? derived(target, prop, { equal: equalFn, vivify: nodeVivify })
        : derived(target, {
            from: (v: any) => v?.[prop],
            onChange: (newValue: any) =>
              target.update((v: any) => {
                const container = vivifyFn(v, prop);
                if (container === null || container === undefined)
                  return container;
                try {
                  container[prop] = newValue;
                } catch (e) {
                  if (isDevMode())
                    console.error(
                      `[store] Failed to set property "${String(prop)}"`,
                      e,
                    );
                }
                return container;
              }),
          });

      const childSample = untracked(computation);
      const childVivify = resolveVivify(childSample, vivify);
      const proxy = Array.isArray(childSample)
        ? toArrayStore(computation, injector, childVivify)
        : toStore(computation, injector, childVivify);
      const ref = new WeakRef(proxy);
      storeCache.set(prop, ref);
      PROXY_CLEANUP.register(proxy, { target, prop }, ref);
      return proxy;
    },
  });

  return s;
}

type ScopeKind = 'mutable' | 'writable' | 'readonly';

/**
 * @internal
 * Backs `store.extend(...)`. Builds a scoped overlay over `parent`: the local layer (the seed
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
  injector: Injector,
): SignalStore<AnyRecord> {
  const local = isSignal(seed)
    ? toStore(seed as Signal<AnyRecord>, injector)
    : kind === 'mutable'
      ? mutableStore(seed, { injector })
      : kind === 'readonly'
        ? store(seed, { injector }).asReadonlyStore()
        : store(seed, { injector });

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
    { pure: false },
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
      if (prop === IS_STORE) return true;
      if (prop === SCOPE_PARENT) return parent;
      if (prop === 'extend')
        return (childSeed: AnyRecord | Signal<AnyRecord>) =>
          scopedStore(scope, childSeed, kind, injector);
      if (prop === 'asReadonlyStore')
        return () =>
          toStore(
            computed(() => ({ ...parent(), ...local() })),
            injector,
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
      return [
        ...new Set<string | symbol>([
          ...Reflect.ownKeys(parentValue()),
          ...Reflect.ownKeys(localValue()),
        ]),
      ];
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
  },
): WritableSignalStore<T> {
  return toStore(signal(value, opt), opt?.injector, opt?.vivify ?? false);
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
  },
): MutableSignalStore<T> {
  return toStore(mutable(value, opt), opt?.injector, opt?.vivify ?? false);
}
