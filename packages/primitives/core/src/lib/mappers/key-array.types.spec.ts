/** Type-level pins for keyArray's overloads (checked by the compiler; no runtime assertions). */
import { signal, type Signal } from '@angular/core';
import { describe, expectTypeOf, it } from 'vitest';
import type { Handle } from './handles';
import {
  keyArray,
  type KeyArrayOptions,
  type MaybeOrderedKeyArray,
  type OrderedKeyArray,
  type Permutation,
} from './key-array';

type Item = { id: string };
const source = signal<Item[]>([]);
const key = (v: Item) => v.id;

describe('keyArray types', () => {
  it('no options: Signal<U[]>, mapFn key is the raw key', () => {
    const r = keyArray(source, (_v, _i, k: string) => k, { key });
    expectTypeOf(r).toEqualTypeOf<Signal<string[]>>();
  });

  it('handles: true ⇒ mapFn key is Handle<K>', () => {
    keyArray(
      source,
      (_v, _i, k) => {
        expectTypeOf(k).toEqualTypeOf<Handle<string>>();
        return 0;
      },
      { key, handles: true },
    );
  });

  it('onDuplicates receives the actual key type', () => {
    keyArray(source, (_v, _i, k: string) => k, {
      key,
      onDuplicates: (keys) =>
        expectTypeOf(keys).toEqualTypeOf<readonly string[]>(),
    });
  });

  it('order: true ⇒ OrderedKeyArray (with handles true, absent or optional)', () => {
    const plain = keyArray(source, (_v, _i, k: string) => k, {
      key,
      order: true,
    });
    expectTypeOf(plain).toEqualTypeOf<OrderedKeyArray<string, string>>();
    expectTypeOf(plain.reorders).toEqualTypeOf<
      Signal<Permutation<Handle<string>> | null>
    >();
    const withHandles = keyArray(source, (_v, _i, k) => k, {
      key,
      handles: true,
      order: true,
    });
    expectTypeOf(withHandles).toEqualTypeOf<
      OrderedKeyArray<Handle<string>, string>
    >();
    const maybe = keyArray(source, (_v, _i, k) => k, {
      key,
      handles: undefined as boolean | undefined,
      order: true,
    });
    expectTypeOf(maybe).toEqualTypeOf<
      OrderedKeyArray<Handle<string>, string>
    >();
  });

  it('non-literal options: reorders is optional but typed', () => {
    const options = { key } as KeyArrayOptions<Item, Handle<string>, string>;
    const r = keyArray(source, (_v, _i, k) => k, options);
    expectTypeOf(r).toEqualTypeOf<
      MaybeOrderedKeyArray<Handle<string>, string>
    >();
    expectTypeOf(r.reorders).toEqualTypeOf<
      Signal<Permutation<Handle<string>> | null> | undefined
    >();
  });
});
