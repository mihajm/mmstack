/**
 * keyArray's `order: true`: `reorders` is the permutation of the entries present in both of two
 * consecutive states (by handle), and `null` when they kept their relative order. The oracle
 * reads survivors off ENTRY identity (the mapped objects), not off the implementation's handles.
 */
import { signal, type Signal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Handle } from './handles';
import { keyArray, type Permutation } from './key-array';

type Item = { readonly id: string; readonly tag: number };
type Entry = {
  readonly item: Item;
  readonly key: unknown;
  readonly index: Signal<number>;
};

let tag = 0;
const item = (id: string): Item => ({ id, tag: tag++ });

function ordered(initial: Item[]) {
  const source = signal(initial);
  const mapped = keyArray(
    source,
    (v, index, key: Handle<string>): Entry => ({ item: v, key, index }),
    {
      key: (v) => v.id,
      handles: true,
      order: true,
    },
  );
  // `reorders` compares against its own last evaluation: read it once to set the baseline
  expect(mapped.reorders()).toBeNull();
  return { source, mapped };
}

describe('keyArray order: true', () => {
  it('[PIN M3 prepend] a prepend is not a reorder, while every index bumps', () => {
    const a = item('a');
    const b = item('b');
    const t = ordered([a, b]);
    const [ea, eb] = t.mapped();
    t.source.set([item('x'), a, b]);
    expect(t.mapped().slice(1)).toEqual([ea, eb]);
    expect(t.mapped.reorders()).toBeNull();
    expect([ea.index(), eb.index()]).toEqual([1, 2]);
  });

  it('[PIN M3 swap] [a,b] → [b,a] names the survivors by handle: [a,b] → [b,a]', () => {
    const a = item('a');
    const b = item('b');
    const t = ordered([a, b]);
    t.mapped();
    t.source.set([b, a]);
    t.mapped();
    expect(t.mapped.reorders()).toEqual({
      before: ['a', 'b'],
      after: ['b', 'a'],
    });
  });

  it('[PIN M3 swap + add] the permutation covers the survivors only', () => {
    const [a, b, c] = [item('a'), item('b'), item('c')];
    const t = ordered([a, b, c]);
    t.mapped();
    t.source.set([c, item('d'), a]);
    expect(t.mapped.reorders()).toEqual({
      before: ['a', 'c'],
      after: ['c', 'a'],
    });
  });

  it('[PIN M3 membership] an insert alone or a removal alone is null', () => {
    const [a, b, c] = [item('a'), item('b'), item('c')];
    const t = ordered([a, b, c]);
    t.mapped();
    t.source.set([a, c]);
    expect(t.mapped.reorders()).toBeNull();
    t.source.set([a, item('n'), c]);
    expect(t.mapped.reorders()).toBeNull();
  });

  it('[PIN M3 multiplicity] [x,x,y] → [y,x,x] moves y against the x group; the xs never permute', () => {
    const x = item('a');
    const y = item('y');
    const t = ordered([x, x, y]);
    const [e0, e1, ey] = t.mapped();
    t.source.set([y, x, x]);
    expect(t.mapped()).toEqual([ey, e0, e1]);
    expect(t.mapped.reorders()).toEqual({
      before: [e0.key, e1.key, 'y'],
      after: ['y', e0.key, e1.key],
    });
  });

  it('[PIN M3 property] non-null iff a survivor changed rank; before/after = one set, never equal', () => {
    const states = fc.array(
      fc.array(
        fc.record({
          id: fc.constantFrom('a', 'b', 'c', 'd'),
          reuse: fc.boolean(),
        }),
        {
          maxLength: 6,
        },
      ),
      { minLength: 1, maxLength: 10 },
    );
    fc.assert(
      fc.property(states, (history) => {
        const pool = new Map<string, Item>();
        const t = ordered([]);
        let prev: Entry[] = t.mapped();
        for (const state of history) {
          const items = state.map(({ id, reuse }) => {
            const old = pool.get(id);
            const next = reuse && old ? old : item(id);
            pool.set(id, next);
            return next;
          });
          t.source.set(items);
          const next = t.mapped();
          const inNext = new Set(next);
          const inPrev = new Set(prev);
          const before = prev.filter((e) => inNext.has(e));
          const after = next.filter((e) => inPrev.has(e));
          const moved = before.some((e, i) => e !== after[i]);
          const got: Permutation<Handle<string>> | null = t.mapped.reorders();
          if (!moved) expect(got).toBeNull();
          else {
            expect(got).toEqual({
              before: before.map((e) => e.key),
              after: after.map((e) => e.key),
            });
            const perm = got ?? { before: [], after: [] };
            expect(perm.before.some((h, i) => h !== perm.after[i])).toBe(true);
            expect(new Set(perm.before)).toEqual(new Set(perm.after));
          }
          prev = next;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('[PIN M3 cost] without the option: no `reorders`, and the same recomputations and key reads', () => {
    const run = (order: boolean) => {
      let sourceRuns = 0;
      let keyReads = 0;
      const base = signal([item('a'), item('b'), item('c')]);
      const mapped = keyArray(
        () => (sourceRuns++, base()),
        (v) => v,
        { key: (v: Item) => (keyReads++, v.id), order },
      );
      mapped();
      base.set([...base()].reverse());
      mapped();
      base.set([item('z'), ...base()]);
      mapped();
      return { sourceRuns, keyReads, hasReorders: 'reorders' in mapped };
    };
    expect(run(false)).toEqual({
      sourceRuns: 3,
      keyReads: 10,
      hasReorders: false,
    });
    expect(run(true)).toEqual({
      sourceRuns: 3,
      keyReads: 10,
      hasReorders: true,
    });
  });
});

describe('keyArray order: true — SameValueZero', () => {
  it('[PIN M3 NaN] a unique NaN key through a fresh array: entry reused, reorders null', () => {
    const a = { id: NaN };
    const source = signal([a]);
    const mapped = keyArray(source, (v) => ({ v }), {
      key: (v) => v.id,
      order: true,
    });
    const [entry] = mapped();
    expect(mapped.reorders()).toBeNull();
    source.set([a]);
    expect(mapped()[0]).toBe(entry);
    expect(mapped.reorders()).toBeNull();
  });

  it('[PIN M3 baseline] writes not seen by `reorders` fold into one transition against its last evaluation', () => {
    const [a, b] = [item('a'), item('b')];
    const t = ordered([a, b]);
    t.mapped();
    t.source.set([b, a]);
    t.source.set([a, b]);
    expect(t.mapped.reorders()).toBeNull();
  });
});

describe('keyArray order: true — reorders keeps its own baseline', () => {
  it('[PIN M3 desync] mapped read at every write, reorders read once: the swap is not lost', () => {
    const [a, b, c] = [item('a'), item('b'), item('c')];
    const t = ordered([a, b]);
    t.source.set([b, a]);
    t.mapped();
    t.source.set([b, a, c]);
    t.mapped();
    expect(t.mapped.reorders()).toEqual({
      before: ['a', 'b'],
      after: ['b', 'a'],
    });
    expect(t.mapped.reorders()).toEqual({
      before: ['a', 'b'],
      after: ['b', 'a'],
    });
    t.source.set([b, a, c, item('d')]);
    expect(t.mapped.reorders()).toBeNull();
  });

  it('[PIN M3 readonly] reorders is a read-only signal', () => {
    const t = ordered([item('a')]);
    expect('set' in t.mapped.reorders).toBe(false);
  });
});
