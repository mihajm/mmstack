import { bytes16, prng } from './prng';

describe('prng (the harness must be reproducible)', () => {
  it('is deterministic: same seed yields the identical stream', () => {
    const a = prng(12345);
    const b = prng(12345);
    const seqA = Array.from({ length: 50 }, () => a.float());
    const seqB = Array.from({ length: 50 }, () => b.float());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = Array.from({ length: 50 }, ((r) => () => r.float())(prng(1)));
    const b = Array.from({ length: 50 }, ((r) => () => r.float())(prng(2)));
    expect(a).not.toEqual(b);
  });

  it('float stays in [0, 1)', () => {
    const r = prng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(n) stays in [0, n) and covers the range', () => {
    const r = prng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const v = r.int(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4])); // every bucket hit
  });

  it('bool honors the probability at the extremes', () => {
    const r = prng(3);
    for (let i = 0; i < 100; i++) {
      expect(r.bool(0)).toBe(false);
      expect(r.bool(1)).toBe(true);
    }
  });

  it('pick returns an element, and throws on empty', () => {
    const r = prng(4);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) expect(arr).toContain(r.pick(arr));
    expect(() => r.pick([])).toThrow();
  });

  it('bytes16 is 16 bytes, in range, and deterministic per seed', () => {
    const a = bytes16(prng(11));
    const b = bytes16(prng(11));
    expect(a.length).toBe(16);
    expect([...a]).toEqual([...b]);
    for (const byte of a) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThan(256);
    }
  });
});
