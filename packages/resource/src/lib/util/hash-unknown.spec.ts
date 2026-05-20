import { hash } from './hash-unknown';

describe('hash', () => {
  it('serializes primitives via JSON', () => {
    expect(hash(1)).toBe('[1]');
    expect(hash('x')).toBe('["x"]');
    expect(hash(true)).toBe('[true]');
    expect(hash(null)).toBe('[null]');
  });

  it('treats argument list as an array', () => {
    expect(hash('a', 1, true)).toBe('["a",1,true]');
  });

  it('is insensitive to plain object key order', () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
  });

  it('sorts keys recursively in nested plain objects', () => {
    const a = hash({ outer: { z: 1, a: 2, m: { y: 1, x: 2 } } });
    const b = hash({ outer: { a: 2, z: 1, m: { x: 2, y: 1 } } });
    expect(a).toBe(b);
  });

  it('preserves array order (positional)', () => {
    expect(hash([1, 2, 3])).not.toBe(hash([3, 2, 1]));
  });

  it('does not sort keys of objects nested inside arrays via array index (still sorts plain object keys themselves)', () => {
    expect(hash([{ a: 1, b: 2 }])).toBe(hash([{ b: 2, a: 1 }]));
  });

  it('key-sorts Object.create(null) objects', () => {
    const o1 = Object.create(null) as Record<string, unknown>;
    o1['a'] = 1;
    o1['b'] = 2;
    const o2 = Object.create(null) as Record<string, unknown>;
    o2['b'] = 2;
    o2['a'] = 1;
    expect(hash(o1)).toBe(hash(o2));
  });

  it('key-sorts class instances', () => {
    class Foo {
      b = 2;
      a = 1;
    }
    class Bar {
      a = 1;
      b = 2;
    }
    // Different construction orders but identical own enumerable state → same hash.
    expect(hash(new Foo())).toBe(hash(new Bar()));
    expect(hash(new Foo())).toBe('[{"a":1,"b":2}]');
  });

  describe('Map', () => {
    it('hashes identically for the same entries regardless of insertion order', () => {
      const m1 = new Map<string, number>();
      m1.set('a', 1);
      m1.set('b', 2);
      const m2 = new Map<string, number>();
      m2.set('b', 2);
      m2.set('a', 1);
      expect(hash(m1)).toBe(hash(m2));
    });

    it('differs across different entries', () => {
      expect(hash(new Map([['a', 1]]))).not.toBe(hash(new Map([['a', 2]])));
      expect(hash(new Map([['a', 1]]))).not.toBe(hash(new Map([['b', 1]])));
    });

    it('does not collide with an empty plain object', () => {
      // Pre-change behavior: JSON.stringify(new Map()) was '{}'. Now it has a marker.
      expect(hash(new Map())).not.toBe(hash({}));
    });

    it('supports complex keys and values', () => {
      const m1 = new Map<unknown, unknown>([[{ id: 1 }, [1, 2]]]);
      const m2 = new Map<unknown, unknown>([[{ id: 1 }, [1, 2]]]);
      expect(hash(m1)).toBe(hash(m2));
    });

    it('sorts by recursive hash so logically-equal object keys produce stable order', () => {
      // Both maps hold the same two keys ({a:1,b:2} and {x:1}) and same values,
      // but the first key is constructed in different orders. Sort must consider
      // the recursive (key-sorted) hash, otherwise the entries array order
      // diverges.
      const m1 = new Map<unknown, unknown>([
        [{ a: 1, b: 2 }, 'v1'],
        [{ x: 1 }, 'v2'],
      ]);
      const m2 = new Map<unknown, unknown>([
        [{ x: 1 }, 'v2'],
        [{ b: 2, a: 1 }, 'v1'],
      ]);
      expect(hash(m1)).toBe(hash(m2));
    });
  });

  describe('Set', () => {
    it('hashes identically for the same values regardless of insertion order', () => {
      expect(hash(new Set([1, 2, 3]))).toBe(hash(new Set([3, 2, 1])));
    });

    it('differs across different values', () => {
      expect(hash(new Set([1, 2]))).not.toBe(hash(new Set([1, 3])));
    });

    it('does not collide with an empty plain object', () => {
      expect(hash(new Set())).not.toBe(hash({}));
    });
  });

  it('serializes Date via its toJSON (ISO string)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(hash(d)).toBe(`["${d.toISOString()}"]`);
  });

  it('collapses undefined and functions to null', () => {
    expect(hash(undefined)).toBe('[null]');
    expect(hash(() => 1)).toBe('[null]');
  });

  it('distinguishes different shapes', () => {
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
    expect(hash({ a: 1 })).not.toBe(hash({ b: 1 }));
  });
});
