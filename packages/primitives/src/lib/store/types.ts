import { type Signal, type WritableSignal } from '@angular/core';
import { type MutableSignal } from '../mutable';
import { type LEAF } from './leaf';
import { type OPAQUE, type UnwrapOpaque } from './opaque';

type BaseType =
  | string
  | number
  | boolean
  | symbol
  | bigint
  | undefined
  | null
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function
  | Date
  | RegExp
  // opaque objects route to the leaf branch
  | { readonly [OPAQUE]: true };

export type Key = string | number;

export type AnyRecord = Record<Key, any>;

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
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type SignalArrayStore<T extends any[]> = Signal<T> & {
  readonly [index: number]: SignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<SignalStore<T[number]>>;
};

export type WritableArrayStore<T extends any[]> = WritableSignal<T> & {
  readonly asReadonlyStore: () => SignalArrayStore<T>;
  readonly [index: number]: WritableSignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<WritableSignalStore<T[number]>>;
};

export type MutableArrayStore<T extends any[]> = MutableSignal<T> & {
  readonly asReadonlyStore: () => SignalArrayStore<T>;
  readonly [index: number]: MutableSignalStore<T[number]>;
  readonly length: Signal<number>;
  [Symbol.iterator](): Iterator<MutableSignalStore<T[number]>>;
};

/** @internal The object shape of a readonly store: a child store per key, plus `extend`. */
type SignalStoreObject<T> = Simplify<
  Readonly<{
    [K in keyof Required<T>]: SignalStore<NonNullable<T>[K]>;
  }> & {
    /** @deprecated Use the standalone `extendStore(store, …)`; the `extend` key is removed next minor. */
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
    /** @deprecated Use the standalone `extendStore(store, …)`; the `extend` key is removed next minor. */
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
    /** @deprecated Use the standalone `extendStore(store, …)`; the `extend` key is removed next minor. */
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

export type SignalStore<T> = Signal<UnwrapOpaque<T>> &
  (IsAny<T> extends true
    ? SignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? { readonly [LEAF]: () => boolean }
      : NonNullable<T> extends any[]
        ? SignalArrayStore<NonNullable<T>>
        : SignalStoreObject<T>);

export type WritableSignalStore<T> = WritableSignal<UnwrapOpaque<T>> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (IsAny<T> extends true
    ? WritableSignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? { readonly [LEAF]: () => boolean }
      : NonNullable<T> extends any[]
        ? WritableArrayStore<NonNullable<T>>
        : WritableSignalStoreObject<T>);

export type MutableSignalStore<T> = MutableSignal<UnwrapOpaque<T>> & {
  readonly asReadonlyStore: () => SignalStore<T>;
} & (IsAny<T> extends true
    ? MutableSignalStoreObject<T>
    : NonNullable<T> extends BaseType
      ? { readonly [LEAF]: () => boolean }
      : NonNullable<T> extends any[]
        ? MutableArrayStore<NonNullable<T>>
        : MutableSignalStoreObject<T>);
