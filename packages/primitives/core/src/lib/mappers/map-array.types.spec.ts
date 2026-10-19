/** Type-level pins for mapArray (checked by the compiler; no runtime assertions). */
import { signal, type Signal } from '@angular/core';
import { describe, expectTypeOf, it } from 'vitest';
import type { Handle } from './handles';
import type { Permutation } from './survivor-permutation';
import { mapArray, type MapArrayOptions, type MappedArray } from './map-array';

type Item = { id: string };
const source = signal<Item[]>([]);
const key = (v: Item) => v.id;

describe('mapArray types', () => {
  it('[PIN MA6] no key ⇒ key: T, handle: Handle<T>, result MappedArray<U, T>', () => {
    const r = mapArray(source, (item, index, k, handle) => {
      expectTypeOf(item).toEqualTypeOf<Signal<Item>>();
      expectTypeOf(index).toEqualTypeOf<Signal<number>>();
      expectTypeOf(k).toEqualTypeOf<Item>();
      expectTypeOf(handle).toEqualTypeOf<Handle<Item>>();
      return 0;
    });
    expectTypeOf(r).toEqualTypeOf<MappedArray<number, Item>>();
    expectTypeOf(r.reorders).toEqualTypeOf<
      Signal<Permutation<Handle<Item>> | null>
    >();
  });

  it('[PIN MA6] with key ⇒ K from it (a declared or annotated key function)', () => {
    const r = mapArray(
      source,
      (_item, _index, k, handle) => {
        expectTypeOf(k).toEqualTypeOf<string>();
        expectTypeOf(handle).toEqualTypeOf<Handle<string>>();
        return k;
      },
      { key },
    );
    expectTypeOf(r).toEqualTypeOf<MappedArray<string, string>>();
    expectTypeOf(r.reorders).toEqualTypeOf<
      Signal<Permutation<Handle<string>> | null>
    >();
    const inline = mapArray(source, (_item, _index, k) => k, {
      key: (v: Item) => v.id,
    });
    expectTypeOf(inline).toEqualTypeOf<MappedArray<string, string>>();
  });

  it('[PIN MA6] an inline unannotated key infers K while mapFn does not name key or handle', () => {
    const r = mapArray(source, (item) => item, { key: (v) => v.id });
    expectTypeOf(r).toEqualTypeOf<MappedArray<Signal<Item>, string>>();
  });

  it('[PIN MA6 inference order] an inline unannotated key does NOT infer K when mapFn names key or handle unannotated (K falls to T)', () => {
    // mapFn is typed before the options argument, so K is fixed at its default T first
    mapArray(source, (_item, _index, k) => k, {
      // @ts-expect-error string is not assignable to Item: K was fixed at T
      key: (v) => v.id,
    });
  });

  it('[PIN MA6] onDuplicates receives the actual key type', () => {
    mapArray(source, (item) => item, {
      key,
      onDuplicates: (keys) =>
        expectTypeOf(keys).toEqualTypeOf<readonly string[]>(),
    });
    expectTypeOf<
      MapArrayOptions<Item, number, string>['onDuplicates']
    >().toEqualTypeOf<((keys: readonly string[]) => void) | undefined>();
  });

  it('[PIN MA6] a mapper that uses the item and index as values does not compile', () => {
    // @ts-expect-error item is a Signal<Item>, index a Signal<number>
    mapArray(source, (item: Item, i: number) => `${item.id}${i}`);
  });

  it('[PIN MA6 silent case] a mapper that only reads item() compiles', () => {
    const r = mapArray(source, (item) => item().id);
    expectTypeOf(r).toEqualTypeOf<MappedArray<string, Item>>();
  });

  it('[PIN MA6] item and index are read-only signals', () => {
    mapArray(source, (item, index) => {
      expectTypeOf(item).not.toHaveProperty('set');
      expectTypeOf(index).not.toHaveProperty('set');
      return 0;
    });
  });
});
