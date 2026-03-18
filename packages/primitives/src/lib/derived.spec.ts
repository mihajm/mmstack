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
});
