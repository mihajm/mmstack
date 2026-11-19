import { computed, signal } from '@angular/core';
import { derived } from './derived';
import { mutable } from './mutable';

describe('derived contract', () => {
  describe('vivify off: a write through a nullish source is dropped', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it.each([
      [
        'null record',
        () => signal<{ name: string } | null>(null),
        'name',
        'Ada',
      ],
      [
        'undefined record',
        () => signal<{ name: string } | undefined>(undefined),
        'name',
        'Ada',
      ],
      ['null array', () => signal<number[] | null>(null), 0, 5],
      [
        'null mutable record',
        () => mutable<{ name: string } | null>(null),
        'name',
        'Ada',
      ],
      ['null mutable array', () => mutable<number[] | null>(null), 0, 5],
    ] as const)('%s', (_, make, key, next) => {
      const src = make() as any;
      const before = src();
      const child = derived(src, key as any) as any;
      let runs = 0;
      const watch = computed(() => {
        runs++;
        return src();
      });
      watch();
      expect(() => child.set(next)).not.toThrow();
      expect(src()).toBe(before);
      watch();
      expect(runs).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('writes again once the source holds a container', () => {
      const src = signal<{ name: string } | null>(null);
      const name = derived(src as any, 'name') as any;
      name.set('Ada');
      src.set({ name: 'x' });
      name.set('Ada');
      expect(src()).toEqual({ name: 'Ada' });
    });
  });

  describe('vivify off over present values', () => {
    it('a numeric key on a record writes a record', () => {
      const src = signal<Record<number, string>>({ 1: 'a' });
      derived(src as any, 1).set('b');
      expect(src()).toEqual({ 1: 'b' });
      expect(Array.isArray(src())).toBe(false);
    });

    it('an array element write copies the array and leaves the original untouched', () => {
      const original = [1, 2, 3];
      const src = signal(original);
      const first = derived(src, 0);
      first.set(10);
      expect(first()).toBe(10);
      expect(src()).toEqual([10, 2, 3]);
      expect(src()).not.toBe(original);
      expect(original).toEqual([1, 2, 3]);
    });
  });

  describe('vivify shapes', () => {
    it("'auto' keeps a present record for a numeric key", () => {
      const src = signal<Record<number, string>>({ 1: 'a' });
      derived(src as any, 1, { vivify: 'auto' }).set('b');
      expect(src()).toEqual({ 1: 'b' });
    });

    it("'auto' on an undefined source makes an array for an index key", () => {
      const src = signal<number[] | undefined>(undefined);
      derived(src as any, 0, { vivify: 'auto' }).set(5);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([5]);
    });

    it("'object' makes an object even for a numeric key", () => {
      const src = signal<Record<number, string> | null>(null);
      derived(src as any, 1, { vivify: 'object' }).set('a');
      expect(Array.isArray(src())).toBe(false);
      expect(src()).toEqual({ 1: 'a' });
    });

    it('a factory over a present array keeps it an array', () => {
      const src = signal([1, 2]);
      derived(src, 0, { vivify: () => [] }).set(9);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([9, 2]);
    });

    it('a factory that returns an object on a null source writes an object for an index key', () => {
      const src = signal<Record<number, number> | null>(null);
      (derived as any)(src, 0, { vivify: () => ({}) }).set(5);
      expect(Array.isArray(src())).toBe(false);
      expect(src()).toEqual({ 0: 5 });
    });

    it('a factory that returns an array on a null source writes an array', () => {
      const src = signal<number[] | null>(null);
      derived(src as any, 0, { vivify: () => [0, 0] }).set(5);
      expect(Array.isArray(src())).toBe(true);
      expect(src()).toEqual([5, 0]);
    });
  });

  describe('derived of a mutable source', () => {
    it('inline edits the source in place and notifies readers of the derived', () => {
      const src = mutable({ a: { n: 1 } });
      const a = derived(src, 'a');
      const n = computed(() => a().n, { equal: () => false });
      expect(n()).toBe(1);
      a.inline((v) => {
        v.n = 2;
      });
      expect(src().a.n).toBe(2);
      expect(n()).toBe(2);
    });
  });
});
