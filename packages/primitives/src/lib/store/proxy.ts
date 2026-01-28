import {
  inject,
  Injector,
  isDevMode,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from '../derived';
import { isWritableSignal } from '../mappers/util';
import { isMutable, mutable, MutableSignal } from '../mutable';
import { toWritable } from '../to-writable';
import type { AnyRecord, BaseType } from './shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

export type SignalStore<T> = Signal<T> &
  (NonNullable<T> extends BaseType
    ? unknown
    : Readonly<{ [K in keyof Required<T>]: SignalStore<NonNullable<T>[K]> }>);

export type WritableSignalStore<T> = WritableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (NonNullable<T> extends BaseType
    ? unknown
    : Readonly<{
        [K in keyof Required<T>]: WritableSignalStore<NonNullable<T>[K]>;
      }>);

export type MutableSignalStore<T> = MutableSignal<T> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (NonNullable<T> extends BaseType
    ? unknown
    : Readonly<{
        [K in keyof Required<T>]: MutableSignalStore<NonNullable<T>[K]>;
      }>);

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
  if ((source as any)[IS_STORE]) return source as any;

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
      return isRecord(v) ? Reflect.ownKeys(v) : [];
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
      }

      const value = untracked(target);
      const valueIsRecord = isRecord(value);

      const equalFn =
        valueIsRecord && isMutableSource && typeof value[prop] === 'object'
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

      const proxy = toStore(computation, injector);
      storeCache.set(prop, new WeakRef(proxy));
      return proxy;
    },
  });

  return s;
}

export function store<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T>,
): WritableSignalStore<T> {
  return toStore(signal(value, opt));
}

export function mutableStore<T extends AnyRecord>(
  value: T,
  opt?: CreateSignalOptions<T>,
): MutableSignalStore<T> {
  return toStore(mutable(value, opt));
}
