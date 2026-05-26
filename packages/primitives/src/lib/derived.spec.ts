import { signal } from '@angular/core';
import { derived, isDerivation } from './derived';
import { mutable } from './mutable';

describe('derived', () => {
  it('should derive from object property with literal string key', () => {
    const user = signal({ name: 'John', age: 30 });
    const name = derived(user, 'name');

    expect(name()).toBe('John');

    name.set('Jane');
    expect(user()).toEqual({ name: 'Jane', age: 30 });
    expect(name()).toBe('Jane');

    expect(isDerivation(name)).toBe(true);
  });

  it('should derive from object property with options object', () => {
    const user = signal({ name: 'John', age: 30 });
    const name = derived(user, {
      from: (u) => u.name,
      onChange: (next) => user.update((u) => ({ ...u, name: next })),
    });

    expect(name()).toBe('John');
    name.set('Jane');
    expect(user()).toEqual({ name: 'Jane', age: 30 });
  });

  it('should derive from mutable signal', () => {
    const user = mutable({ name: 'John', age: 30 });
    const nameSig = derived(user, 'name');

    expect(nameSig()).toBe('John');
    nameSig.set('Jane');
    expect(user()).toEqual({ name: 'Jane', age: 30 });
    expect(nameSig()).toBe('Jane');

    // Testing mutable.mutate inside derived
    nameSig.mutate(() => 'Alice');
    expect(user()).toEqual({ name: 'Alice', age: 30 });
  });

  it('should derive from array', () => {
    const list = signal([1, 2, 3]);
    const first = derived(list, 0);

    expect(first()).toBe(1);
    first.set(10);
    expect(list()).toEqual([10, 2, 3]);
  });

  it('should derive from mutable array', () => {
    const list = mutable([1, 2, 3]);
    const first = derived(list, 0);

    expect(first()).toBe(1);
    first.set(10);
    expect(list()).toEqual([10, 2, 3]);

    first.mutate(() => 20);
    expect(list()).toEqual([20, 2, 3]);
  });

  it('should handle re-entrant mutate calls without throwing or dropping state', () => {
    const state = mutable({ items: [{ id: 1, n: 0 }] });
    const items = derived(state, 'items');

    // Outer mutate that re-enters itself synchronously. With the boolean
    // `trigger` flag the inner call would flip it back to false before the
    // outer's equality check fires; the counter implementation must keep the
    // "force inequality" guard active for the full outer scope.
    items.mutate((arr) => {
      items.mutate((inner) => {
        inner.push({ id: 2, n: 0 });
        return inner;
      });
      arr.push({ id: 3, n: 0 });
      return arr;
    });

    expect(items().length).toBe(3);
    expect(state().items.length).toBe(3);
  });
});
