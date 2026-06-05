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

describe('derived vivify', () => {
  it('is off by default — updates a present source without creating', () => {
    const src = signal({ a: 1 });
    derived(src, 'a').set(2);
    expect(src()).toEqual({ a: 2 });
  });

  describe('object shape on a nullish source', () => {
    it('vivifies an immutable source', () => {
      const src = signal(null as unknown as { b: number });
      derived(src, 'b', { vivify: 'object' }).set(2);
      expect(src()).toEqual({ b: 2 });
    });

    it('vivifies a mutable source', () => {
      const src = mutable(null as unknown as { b: number });
      derived(src, 'b', { vivify: 'object' }).set(2);
      expect(src()).toEqual({ b: 2 });
    });

    it("resolves 'auto' to an object for a string key", () => {
      const src = signal(null as unknown as { b: number });
      derived(src, 'b', { vivify: 'auto' }).set(2);
      expect(src()).toEqual({ b: 2 });
    });
  });

  describe('array shape on a nullish source', () => {
    it('vivifies an immutable source into a real array', () => {
      const src = signal(null as unknown as number[]);
      derived(src, 0, { vivify: 'array' }).set(5);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([5]);
    });

    it('vivifies a mutable source into a real array', () => {
      const src = mutable(null as unknown as number[]);
      derived(src, 0, { vivify: 'array' }).set(5);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([5]);
    });

    it("resolves 'auto' to an array for a numeric key", () => {
      const src = signal(null as unknown as number[]);
      derived(src, 0, { vivify: 'auto' }).set(5);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([5]);
    });

    it('true behaves like auto', () => {
      const src = signal(null as unknown as number[]);
      derived(src, 0, { vivify: true }).set(7);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([7]);
    });
  });

  describe('a present source is preserved, never replaced', () => {
    it('keeps sibling keys (immutable, explicit shape)', () => {
      const src = signal({ a: 1, x: 9 });
      derived(src, 'a', { vivify: 'object' }).set(5);
      expect(src()).toEqual({ a: 5, x: 9 });
    });

    it('keeps sibling keys (factory is not used for a present value)', () => {
      const src = signal({ a: 1, x: 9 });
      derived(src, 'a', { vivify: () => ({ a: 0, x: 0 }) }).set(5);
      expect(src()).toEqual({ a: 5, x: 9 });
    });

    it('keeps other elements (immutable array)', () => {
      const src = signal([1, 2, 3]);
      derived(src, 0, { vivify: 'array' }).set(10);
      expect(src()).toEqual([10, 2, 3]);
    });

    it('mutates a present mutable source in place (same reference)', () => {
      const src = mutable({ a: 1, x: 9 });
      const ref = src();
      derived(src, 'a', { vivify: 'object' }).set(5);
      expect(src()).toBe(ref);
      expect(src()).toEqual({ a: 5, x: 9 });
    });
  });

  describe('factory', () => {
    it('seeds the container when the source is nullish', () => {
      const src = signal(null as unknown as { b: number; seeded?: boolean });
      derived(src, 'b', { vivify: () => ({ b: 0, seeded: true }) }).set(2);
      expect(src()).toEqual({ b: 2, seeded: true });
    });

    it('produces distinct instances per derivation', () => {
      const make = () => ({ seeded: true }) as Record<string, unknown>;
      const s1 = signal(null as unknown as Record<string, unknown>);
      const s2 = signal(null as unknown as Record<string, unknown>);
      derived(s1, 'b', { vivify: make }).set(1);
      derived(s2, 'b', { vivify: make }).set(2);
      expect(s1()).not.toBe(s2());
      expect(s1()).toEqual({ seeded: true, b: 1 });
      expect(s2()).toEqual({ seeded: true, b: 2 });
    });
  });

  it('handles re-entrant mutate with vivify enabled (present source)', () => {
    const state = mutable({ items: [{ id: 1, n: 0 }] });
    const items = derived(state, 'items', { vivify: 'auto' });
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

  it('vivifies an undefined source (not only null)', () => {
    const src = signal(undefined as unknown as { b: number });
    derived(src, 'b', { vivify: 'object' }).set(2);
    expect(src()).toEqual({ b: 2 });
  });

  it('composes vivify through a derived-of-a-derived', () => {
    const src = signal(null as unknown as { a: { b: number } });
    const a = derived(src, 'a', { vivify: 'object' });
    const b = derived(a, 'b', { vivify: 'object' });
    b.set(2);
    expect(src()).toEqual({ a: { b: 2 } });
  });

  it('immutable array vivify copies (does not mutate the source array)', () => {
    const src = signal([1, 2, 3]);
    const before = src();
    derived(src, 0, { vivify: 'array' }).set(10);
    expect(src()).toEqual([10, 2, 3]);
    expect(src()).not.toBe(before); // copy-on-write
    expect(before).toEqual([1, 2, 3]); // original untouched
  });
});
