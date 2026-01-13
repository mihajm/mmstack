// Credit to NGRX signal store, adaptation for purposes of supporting Writable/Mutable signals
// Link to source: https://github.com/ngrx/platform/blob/main/modules/signals/src/deep-signal.ts

import {
  CreateSignalOptions,
  inject,
  Injector,
  isDevMode,
  isSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived, DerivedSignal } from './derived';
import { mutable, type MutableSignal } from './mutable';
import { nestedEffect } from './nested-effect';

type AnyRecord = Record<PropertyKey, any>;

type NonRecord =
  | Iterable<any>
  | WeakSet<any>
  | WeakMap<any, any>
  | Promise<any>
  | Date
  | Error
  | RegExp
  | ArrayBuffer
  | DataView
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function
  | Array<any>;

export type IsRecord<T> = T extends object
  ? T extends NonRecord
    ? false
    : true
  : false;

export type IsUnknownRecord<T> = keyof T extends never
  ? true
  : string extends keyof T
    ? true
    : symbol extends keyof T
      ? true
      : number extends keyof T
        ? true
        : false;

export type IsKnownRecord<T> =
  IsRecord<T> extends true
    ? IsUnknownRecord<T> extends true
      ? false
      : true
    : false;

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
  typeof Iterator !== 'undefined' ? Iterator : class {},
  Array,
]);

export type SignalStore<T> = Signal<T> &
  (IsKnownRecord<T> extends true
    ? Readonly<{
        [K in keyof T]: IsKnownRecord<T[K]> extends true
          ? SignalStore<T[K]>
          : Signal<T[K]>;
      }>
    : unknown);

export type WritableSignalStore<T> = WritableSignal<T> &
  (IsKnownRecord<T> extends true
    ? Readonly<{
        [K in keyof T]: IsKnownRecord<T[K]> extends true
          ? WritableSignalStore<T[K]>
          : WritableSignal<T[K]>;
      }>
    : unknown);

export type MutableSignalStore<T> = MutableSignal<T> &
  (IsKnownRecord<T> extends true
    ? Readonly<{
        [K in keyof T]: IsKnownRecord<T[K]> extends true
          ? MutableSignalStore<T[K]>
          : MutableSignal<T[K]>;
      }>
    : unknown);

type inferValid<T extends AnyRecord> =
  IsKnownRecord<T> extends false ? never : T;

function isIterable(value: AnyRecord): value is Iterable<any> {
  return typeof value?.[Symbol.iterator] === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isIterable(value)) {
    return false;
  }

  let proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype) {
    return true;
  }

  while (proto && proto !== Object.prototype) {
    if (TREAT_AS_VALUE.has(proto.constructor)) return false;

    proto = Object.getPrototypeOf(proto);
  }

  return proto === Object.prototype;
}

const STORE = Symbol(isDevMode() ? 'SIGNAL_STORE' : '');
const STORE_PROXY = Symbol(isDevMode() ? 'SIGNAL_STORE_PROXY' : '');

export function toStore<T extends AnyRecord>(
  source: MutableSignal<inferValid<T>>,
  injector?: Injector,
): MutableSignalStore<T>;

export function toStore<T extends AnyRecord>(
  source: WritableSignal<inferValid<T>>,
  injector?: Injector,
): WritableSignalStore<T>;

export function toStore<T extends AnyRecord>(
  source: Signal<inferValid<T>>,
  injector?: Injector,
): SignalStore<T>;

export function toStore<T extends AnyRecord>(
  source:
    | Signal<inferValid<T>>
    | WritableSignal<inferValid<T>>
    | MutableSignal<inferValid<T>>,
  injector = inject(Injector),
): SignalStore<T> | WritableSignalStore<T> | MutableSignalStore<T> {
  return new Proxy(source, {
    has(_: any, prop) {
      return Reflect.has(untracked(source), prop);
    },
    get(target: any, prop) {
      const value = untracked(target);
      if (!isRecord(value) || !(prop in value)) {
        if (isSignal(target[prop]) && (target[prop] as any)[STORE]) {
          delete target[prop];
        }

        return target[prop];
      }

      if ((target[prop] as any)[STORE_PROXY]) {
        return (target[prop] as any)[STORE_PROXY];
      }

      let computation: DerivedSignal<typeof target, typeof prop>;
      if (!isSignal(target[prop])) {
        computation = derived(target, prop);

        Object.defineProperty(target, prop, {
          value: computation,
          configurable: true,
        });
        target[prop][STORE] = true;
      }

      const proxy = toStore(target[prop], injector);

      const cleanupRef = nestedEffect(
        () => {
          if (Reflect.has(source(), prop)) return;
          delete target[prop];
          cleanupRef.destroy();
        },
        { injector },
      );

      (target[prop] as any)[STORE_PROXY] = proxy;
      return proxy;
    },
  });
}

export function store<T extends AnyRecord>(
  value: inferValid<T>,
  opt?: CreateSignalOptions<T>,
): WritableSignalStore<T> {
  return toStore(signal(value, opt));
}

export function mutableStore<T extends AnyRecord>(
  value: inferValid<T>,
  opt?: CreateSignalOptions<T>,
): MutableSignalStore<T> {
  return toStore(mutable(value, opt));
}
