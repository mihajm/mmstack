import { generateID, mergeArray, mergeIfObject } from './util';

describe('util', () => {
  describe('mergeIfObject', () => {
    it('should overwrite primitive values', () => {
      expect(mergeIfObject(1, 2)).toBe(2);
      expect(mergeIfObject('a', 'b')).toBe('b');
      expect(mergeIfObject(true, false)).toBe(false);
    });

    it('should return next if types do not match', () => {
      expect(mergeIfObject(1 as any, '2' as any)).toBe('2');
      expect(mergeIfObject({} as any, 2 as any)).toBe(2);
    });

    it('should return next if either is null', () => {
      expect(mergeIfObject(null as any, {} as any)).toEqual({});
      expect(mergeIfObject({} as any, null as any)).toBe(null);
      expect(mergeIfObject(null, null)).toBe(null);
    });

    it('should shallow merge objects', () => {
      const prev = { a: 1, b: 2 };
      const next = { b: 3, c: 4 };
      expect(mergeIfObject(prev as any, next as any)).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should merge arrays element by element', () => {
      const prev = [1, { id: 1 }, [10]];
      const next = [2, { id: 1, name: 'A' }, [20, 21]];
      expect(mergeIfObject(prev as any, next as any)).toEqual([
        2,
        { id: 1, name: 'A' },
        [20, 21],
      ]);
    });

    it('should return next if one is array and other object', () => {
      expect(mergeIfObject([] as any, {} as any)).toEqual({});
      expect(mergeIfObject({} as any, [] as any)).toEqual([]);
    });

    it('should return next if prev is undefined but next is an object', () => {
      expect(mergeIfObject(undefined as any, { a: 1 })).toEqual({ a: 1 });
    });
  });

  describe('mergeArray', () => {
    it('should merge length up to next array', () => {
      const prev = [1, 2, 3];
      const next = [10, 20];
      expect(mergeArray(prev, next)).toEqual([10, 20]);
    });

    it('should merge missing previous elements', () => {
      const prev = [{ a: 1 }];
      const next = [{ a: 1, b: 2 }, { c: 3 }];
      expect(mergeArray(prev as any, next as any)).toEqual([{ a: 1, b: 2 }, { c: 3 }]);
    });

    it('should merge complex structures', () => {
      const prev = [1, { id: 1, name: 'A' }, [10], 'extraPrev'];
      const next = [
        2,
        { id: 1, status: 'B' },
        [20, 21],
        undefined,
        { id: 2 },
      ];
      expect(mergeArray(prev as any, next as any)).toEqual([
        2,
        { id: 1, name: 'A', status: 'B' },
        [20, 21],
        undefined,
        { id: 2 },
      ]);
    });
  });

  describe('generateID', () => {
    it('should generate a unique id string', () => {
      const id1 = generateID();
      const id2 = generateID();
      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(0);
    });

    it('should fallback if crypto.randomUUID is not available', () => {
      vi.stubGlobal('crypto', undefined);

      const id1 = generateID();
      const id2 = generateID();

      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });
    
    it('should fallback if crypto is available but randomUUID is not', () => {
      vi.stubGlobal('crypto', { getRandomValues: vi.fn() });

      const id1 = generateID();
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });
  });
});
