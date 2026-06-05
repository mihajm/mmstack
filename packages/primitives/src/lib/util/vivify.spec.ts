import { createVivify } from './vivify';

describe('createVivify', () => {
  it('false → identity (returns the current value as-is, including null)', () => {
    const fn = createVivify(false);
    expect(fn(null as never, 'k')).toBeNull();
    const obj = { a: 1 };
    expect(fn(obj, 'k')).toBe(obj);
  });

  describe("'object'", () => {
    it('creates a plain object for a nullish value', () => {
      const fn = createVivify<Record<string, unknown>>('object');
      expect(fn(null as never, 'k')).toEqual({});
      expect(Array.isArray(fn(null as never, 'k'))).toBe(false);
    });

    it('keeps a present value', () => {
      const fn = createVivify<Record<string, unknown>>('object');
      const obj = { a: 1 };
      expect(fn(obj, 'k')).toBe(obj);
    });
  });

  describe("'array'", () => {
    it('creates an array for a nullish value', () => {
      const fn = createVivify<unknown[]>('array');
      expect(Array.isArray(fn(null as never, 0))).toBe(true);
      expect(fn(null as never, 0)).toEqual([]);
    });

    it('keeps a present value', () => {
      const fn = createVivify<unknown[]>('array');
      const arr = [1, 2];
      expect(fn(arr, 0)).toBe(arr);
    });
  });

  describe("'auto'", () => {
    it('creates an array for an index key', () => {
      const fn = createVivify('auto');
      expect(Array.isArray(fn(null as never, 0))).toBe(true);
      expect(Array.isArray(fn(null as never, '0'))).toBe(true);
    });

    it('creates an object for a non-index key', () => {
      const fn = createVivify('auto');
      expect(Array.isArray(fn(null as never, 'name'))).toBe(false);
      expect(fn(null as never, 'name')).toEqual({});
    });
  });

  it('true behaves like auto', () => {
    const fn = createVivify(true);
    expect(Array.isArray(fn(null as never, 0))).toBe(true);
    expect(Array.isArray(fn(null as never, 'name'))).toBe(false);
  });

  describe('factory', () => {
    it('returns the factory result for a nullish value', () => {
      const fn = createVivify(() => ({ seeded: true }));
      expect(fn(null as never, 'k')).toEqual({ seeded: true });
    });

    it('keeps a present value (does not call the factory)', () => {
      const fn = createVivify(() => ({ seeded: true }));
      const present = { a: 1 };
      expect(fn(present as never, 'k')).toBe(present);
    });

    it('produces a fresh instance per nullish call', () => {
      const fn = createVivify(() => ({ seeded: true }));
      expect(fn(null as never, 'k')).not.toBe(fn(null as never, 'k'));
    });
  });
});
