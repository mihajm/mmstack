import {
  inject,
  Injector,
  isSignal,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived } from './derived';
import { mutable, MutableSignal } from './mutable';

type AnyRecord = Record<PropertyKey, any>;

const TREAT_AS_VALUE = new Set([
  Date,
  Error,
  RegExp,
  ArrayBuffer,
  DataView,
  Function,
  WeakSet,
  WeakMap,
  WeakRef,
  Promise,
  Array,
  typeof Iterator !== 'undefined' ? Iterator : class {},
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (
    Array.isArray(value) ||
    typeof (value as any)[Symbol.iterator] === 'function'
  )
    return false;

  let proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype) return true;

  while (proto && proto !== Object.prototype) {
    if (TREAT_AS_VALUE.has(proto.constructor)) return false;
    proto = Object.getPrototypeOf(proto);
  }
  return proto === Object.prototype;
}

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
  | RegExp
  | any[];

export type SignalStore<T> = Signal<T> &
  (T extends BaseType
    ? unknown
    : Readonly<{ [K in keyof T]: SignalStore<T[K]> }>);

export type WritableSignalStore<T> = WritableSignal<T> &
  (T extends BaseType
    ? unknown
    : Readonly<{ [K in keyof T]: WritableSignalStore<T[K]> }>);

export type MutableSignalStore<T> = MutableSignal<T> &
  (T extends BaseType
    ? unknown
    : Readonly<{ [K in keyof T]: MutableSignalStore<T[K]> }>);

const PROXY_CACHE = new WeakMap<object, Map<PropertyKey, WeakRef<any>>>();

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

export function toStore<T extends AnyRecord>(
  source: Signal<T> | WritableSignal<T> | MutableSignal<T>,
  injector = inject(Injector),
): SignalStore<T> | WritableSignalStore<T> | MutableSignalStore<T> {
  return new Proxy(source, {
    has(_: any, prop) {
      return Reflect.has(untracked(source), prop);
    },
    get(target: any, prop) {
      let storeCache = PROXY_CACHE.get(target);
      if (!storeCache) {
        storeCache = new Map();
        PROXY_CACHE.set(target, storeCache);
      }

      const cachedRef = storeCache.get(prop);
      if (cachedRef) {
        const cached = cachedRef.deref();
        if (cached) return cached;
        storeCache.delete(prop); // Cleanup dead ref
      }

      if (
        prop === 'set' ||
        prop === 'update' ||
        prop === 'asReadonly' ||
        typeof prop === 'symbol'
      ) {
        return target[prop];
      }

      const value = untracked(target);
      if (!isRecord(value)) return target[prop];

      let computation = target[prop];

      if (!isSignal(computation)) {
        computation = derived(target, prop);
        Object.defineProperty(target, prop, {
          value: computation,
          configurable: true,
          writable: true,
        });
      }

      const proxy = toStore(computation, injector);
      storeCache.set(prop, new WeakRef(proxy));

      return proxy;
    },
  });
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
