import { signal } from '@angular/core';
import { pooledArray, pooledMap, pooledSet } from './provided-pools';

describe('pooledArray', () => {
  it('shorthand: reflects pushed contents and clears between reads', () => {
    const src = signal(0);
    const sig = pooledArray<number[]>((buf) => {
      for (let i = 0; i < src(); i++) buf.push(i);
      return buf;
    });

    src.set(3);
    expect(sig()).toEqual([0, 1, 2]);

    src.set(1);
    expect(sig()).toEqual([0]);

    src.set(0);
    expect(sig()).toEqual([]);
  });

  it('object form: honors user-supplied create/reset overrides', () => {
    const src = signal(0);
    const create = vi.fn(() => [] as number[]);
    const reset = vi.fn((arr: number[]) => {
      arr.length = 0;
    });

    const sig = pooledArray<number[]>({
      create,
      reset,
      computation: (buf) => {
        buf.push(src());
        return buf;
      },
    });

    sig();
    src.set(1);
    sig();
    src.set(2);
    sig();
    src.set(3);
    sig();

    expect(create).toHaveBeenCalledTimes(2);
    // reset-on-release: first read has no buffer to release, every read after does
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('alternates between two buffer instances', () => {
    const src = signal(0);
    const sig = pooledArray<number[]>((buf) => {
      buf.push(src());
      return buf;
    });

    src.set(1);
    const a = sig();
    src.set(2);
    const b = sig();
    src.set(3);
    const c = sig();

    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});

describe('pooledMap', () => {
  it('shorthand: reflects set entries and clears between reads', () => {
    const src = signal<{ id: number; name: string }[]>([]);

    const sig = pooledMap<Map<number, string>>((buf) => {
      for (const u of src()) buf.set(u.id, u.name);
      return buf;
    });

    src.set([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(Array.from(sig().entries())).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);

    src.set([{ id: 3, name: 'c' }]);
    expect(Array.from(sig().entries())).toEqual([[3, 'c']]);

    src.set([]);
    expect(sig().size).toBe(0);
  });

  it('alternates between two buffer instances', () => {
    const src = signal(0);
    const sig = pooledMap<Map<number, number>>((buf) => {
      buf.set(src(), src());
      return buf;
    });

    src.set(1);
    const a = sig();
    src.set(2);
    const b = sig();
    src.set(3);
    const c = sig();

    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});

describe('pooledSet', () => {
  it('shorthand: reflects added values and clears between reads', () => {
    const src = signal<string[]>([]);

    const sig = pooledSet<Set<string>>((buf) => {
      for (const v of src()) buf.add(v);
      return buf;
    });

    src.set(['a', 'b', 'a']);
    expect(Array.from(sig())).toEqual(['a', 'b']);

    src.set(['c']);
    expect(Array.from(sig())).toEqual(['c']);

    src.set([]);
    expect(sig().size).toBe(0);
  });

  it('alternates between two buffer instances', () => {
    const src = signal(0);
    const sig = pooledSet<Set<number>>((buf) => {
      buf.add(src());
      return buf;
    });

    src.set(1);
    const a = sig();
    src.set(2);
    const b = sig();
    src.set(3);
    const c = sig();

    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
