import {
  computed,
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from './derived';
import { isWritableSignal } from './mappers/util';
import { isMutable, mutable, MutableSignal } from './mutable';
import { toWritable } from './to-writable';

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
const PROXY_CACHE = new WeakMap<
  object,
  Map<PropertyKey, WeakRef<SignalStore<any>>>
>();

const SIGNAL_FN_PROP = new Set([
  'set',
  'update',
  'mutate',
  'inline',
  'asReadonly',
]);

const PROXY_CLEANUP = new FinalizationRegistry<{
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

function isIndexProp(prop: PropertyKey): prop is `${number}` {
  return typeof prop === 'string' && prop.trim() !== '' && !isNaN(+prop);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
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
): MutableArrayStore<T>;
function toArrayStore<T extends any[]>(
  source: WritableSignal<T>,
  injector: Injector,
): WritableArrayStore<T>;

/**
 * @internal
 * Makes an array store
 */
function toArrayStore<T extends any[]>(
  source: WritableSignal<T> | MutableSignal<T>,
  injector: Injector,
): WritableArrayStore<T> | MutableArrayStore<T> {
  if (isStore<T>(source)) return source as MutableArrayStore<T>;

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
      const arr = v.map((_, i) => String(i));
      arr.push('length');
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

        const equalFn =
          (valueIsRecord || valueIsArray) &&
          isMutableSource &&
          typeof (value as Record<string, any>)[idx] === 'object'
            ? () => false
            : undefined;

        const computation = valueIsRecord
          ? derived(target, idx as any, { equal: equalFn })
          : derived(target, {
              from: (v: any) => v?.[idx],
              onChange: (newValue: any) =>
                target.update((v: any) => {
                  if (v === null || v === undefined) return v;
                  try {
                    v[idx] = newValue;
                  } catch (e) {
                    if (isDevMode())
                      console.error(
                        `[store] Failed to set property "${String(idx)}"`,
                        e,
                      );
                  }
                  return v;
                }),
            });

        const proxy = Array.isArray(untracked(computation))
          ? toArrayStore(computation, injector)
          : toStore(computation, injector);

        const ref = new WeakRef(proxy);
        storeCache.set(idx, ref);
        PROXY_CLEANUP.register(proxy, { target, prop: idx }, ref);
        return proxy;
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as MutableArrayStore<T>;
}

export type SignalStore<T> = Signal<T> &
  (NonNullable<T> extends BaseType
    ? unknown
    : NonNullable<T> extends Array<any>
      ? SignalArrayStore<NonNullable<T>>
      : Readonly<{ [K in keyof Required<T>]: SignalStore<NonNullable<T>[K]> }>);

export type WritableSignalStore<T> = WritableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (NonNullable<T> extends BaseType
    ? unknown
    : NonNullable<T> extends Array<any>
      ? WritableArrayStore<NonNullable<T>>
      : Readonly<{
          [K in keyof Required<T>]: WritableSignalStore<NonNullable<T>[K]>;
        }>);

export type MutableSignalStore<T> = MutableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (NonNullable<T> extends BaseType
    ? unknown
    : NonNullable<T> extends Array<any>
      ? MutableArrayStore<NonNullable<T>>
      : Readonly<{
          [K in keyof Required<T>]: MutableSignalStore<NonNullable<T>[K]>;
        }>);

export function toStore<T extends AnyRecord>(
  source: MutableSignal<T>,
  injector?: Injector,
): MutableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: WritableSignal<T>,
  injector?: Injector,
): WritableSignalStore<T>;
export function toStore<T extends AnyRecord>(
  source: Signal<T>,
  injector?: Injector,
): SignalStore<T>;

/**
 * @experimental This API is experimental and may change or be removed in future releases.
 * Converts a Signal into a deep-observable Store.
 * Accessing nested properties returns a derived Signal of that path.
 * @example
 * const state = store({ user: { name: 'John' } });
 * const nameSignal = state.user.name; // WritableSignal<string>
 */
export function toStore<T extends AnyRecord>(
  source: Signal<T> | WritableSignal<T> | MutableSignal<T>,
  injector?: Injector,
): SignalStore<T> | WritableSignalStore<T> | MutableSignalStore<T> {
  if (isStore<T>(source)) return source;

  if (!injector) injector = inject(Injector);

  const writableSource = isWritableSignal(source)
    ? source
    : toWritable(source, () => {
        // noop
      });

  const isMutableSource = isMutable(writableSource);

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
          if (!isWritableSignal(source)) return s;
          return untracked(() => toStore(source.asReadonly(), injector));
        };

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

      const equalFn =
        (valueIsRecord || valueIsArray) &&
        isMutableSource &&
        typeof (value as Record<string, any>)[prop] === 'object'
          ? () => false
          : undefined;
      const computation = valueIsRecord
        ? derived(target, prop, { equal: equalFn })
        : derived(target, {
            from: (v: any) => v?.[prop],
            onChange: (newValue: any) =>
              target.update((v: any) => {
                if (v === null || v === undefined) return v;
                try {
                  v[prop] = newValue;
                } catch (e) {
                  if (isDevMode())
                    console.error(
                      `[store] Failed to set property "${String(prop)}"`,
                      e,
                    );
                }
                return v;
              }),
          });

      const proxy = Array.isArray(untracked(computation))
        ? toArrayStore(computation, injector)
        : toStore(computation, injector);
      const ref = new WeakRef(proxy);
      storeCache.set(prop, ref);
      PROXY_CLEANUP.register(proxy, { target, prop }, ref);
      return proxy;
    },
  });

  return s;
}

/**
 * Creates a WritableSignalStore from a value.
 * @see {@link toStore}
 */
export function store<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T> & {
    injector?: Injector;
  },
): WritableSignalStore<T> {
  return toStore(signal(value, opt), opt?.injector);
}

/**
 * Creates a MutableSignalStore from a value.
 * @see {@link toStore}
 */
export function mutableStore<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T> & {
    injector?: Injector;
  },
): MutableSignalStore<T> {
  return toStore(mutable(value, opt), opt?.injector);
}
