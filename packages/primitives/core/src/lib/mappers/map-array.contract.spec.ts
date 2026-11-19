import { computed, signal, type Signal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mutable } from '../mutable';
import { keyArray } from './key-array';
import { mapArray } from './map-array';

type Item = { readonly id: string; readonly boom?: boolean };
type Entry = {
  readonly id: string;
  readonly item: Signal<Item> | null;
  readonly index: Signal<number>;
};

/** Live entries must be exactly the output, and nothing is destroyed twice. */
function lifecycle() {
  const built = new Set<Entry>();
  const destroyed = new Set<Entry>();
  let doubleDestroy = 0;
  return {
    build(e: Entry) {
      built.add(e);
      return e;
    },
    destroy(e: Entry) {
      if (destroyed.has(e)) doubleDestroy++;
      destroyed.add(e);
    },
    check(out: readonly Entry[], items: readonly Item[]) {
      expect(doubleDestroy).toBe(0);
      const live = [...built].filter((e) => !destroyed.has(e));
      expect(new Set(out)).toEqual(new Set(live));
      expect(out.length).toBe(items.length);
      out.forEach((e, j) => {
        expect(destroyed.has(e)).toBe(false);
        expect(e.id).toBe(items[j].id);
        expect(e.index()).toBe(j);
        if (e.item) expect(e.item()).toBe(items[j]);
      });
    },
  };
}

const flavors = [
  {
    name: 'mapArray',
    make: (
      src: Signal<Item[]>,
      lc: ReturnType<typeof lifecycle>,
      destroyBoom: boolean,
    ) =>
      mapArray(
        src,
        (item, index) => {
          if (item().boom && !destroyBoom) throw new Error('build failed');
          return lc.build({ id: item().id, item, index });
        },
        {
          key: (i) => i.id,
          onDestroy: (e) => {
            lc.destroy(e);
            if (destroyBoom && e.item?.().boom)
              throw new Error('destroy failed');
          },
        },
      ),
  },
  {
    name: 'keyArray',
    make: (
      src: Signal<Item[]>,
      lc: ReturnType<typeof lifecycle>,
      destroyBoom: boolean,
    ) => {
      const boomIds = new Set<string>();
      return keyArray(
        src,
        (item, index) => {
          if (item.boom && !destroyBoom) throw new Error('build failed');
          if (item.boom) boomIds.add(item.id);
          return lc.build({ id: item.id, item: null, index });
        },
        {
          key: (i) => i.id,
          onDestroy: (e) => {
            lc.destroy(e);
            if (destroyBoom && boomIds.has(e.id))
              throw new Error('destroy failed');
          },
        },
      );
    },
  },
];

describe.each(flavors)('$name: a throwing mapFn or onDestroy', ({ make }) => {
  it('a mapFn throw leaves the mapper consistent for the next state', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c', boom: true };
    const src = signal<Item[]>([a, b]);
    const lc = lifecycle();
    const out = make(src, lc, false);
    lc.check(out(), src());
    src.set([c, a, b]);
    expect(() => out()).toThrow('build failed');
    src.set([a, b]);
    lc.check(out(), src());
    src.set([b, { id: 'd' }]);
    lc.check(out(), src());
  });

  it('an onDestroy throw leaves the mapper consistent for the next state', () => {
    const a = { id: 'a' };
    const b = { id: 'b', boom: true };
    const c = { id: 'c' };
    const src = signal<Item[]>([a, b, c]);
    const lc = lifecycle();
    const out = make(src, lc, true);
    lc.check(out(), src());
    src.set([a]);
    expect(() => out()).toThrow('destroy failed');
    src.set([a, { id: 'd' }]);
    lc.check(out(), src());
  });

  it.each([false, true])(
    'random histories with failing callbacks keep live entries equal to the output (destroy throws: %s)',
    (destroyBoom) => {
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const state = fc.array(
        fc.record({ id: fc.constantFrom(...ids), boom: fc.boolean() }),
        { maxLength: 5 },
      );
      fc.assert(
        fc.property(
          fc.array(state, { minLength: 1, maxLength: 8 }),
          (states) => {
            const uniq = (xs: Item[]) =>
              xs.filter((x, i) => xs.findIndex((y) => y.id === x.id) === i);
            const src = signal<Item[]>([]);
            const lc = lifecycle();
            const out = make(src, lc, destroyBoom);
            for (const s of states) {
              src.set(uniq(s));
              let ok = true;
              try {
                out();
              } catch {
                ok = false;
              }
              if (ok) lc.check(out(), src());
            }
            src.set(src().map((x) => ({ id: x.id })));
            lc.check(out(), src());
          },
        ),
        { numRuns: 150 },
      );
    },
  );
});

describe('mapArray over a mutable() source', () => {
  it('an in-place edit of an item reaches its row', () => {
    const items = mutable([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
    const rows = mapArray(
      items,
      (child, index) => computed(() => `${index()}: ${child().name}`),
      { key: (i) => i.id },
    );
    expect(rows().map((r) => r())).toEqual(['0: A', '1: B']);
    items.mutate((a) => {
      a[0].name = 'Z';
      return a;
    });
    expect(rows().map((r) => r())).toEqual(['0: Z', '1: B']);
    items.inline((a) => {
      a[1].name = 'Y';
    });
    expect(rows().map((r) => r())).toEqual(['0: Z', '1: Y']);
  });

  it('an unchanged primitive slot does not re-run its row', () => {
    const items = mutable([1, 2]);
    let runs = 0;
    const rows = mapArray(items, (child) =>
      computed(() => {
        runs++;
        return child();
      }),
    );
    rows()[0]();
    rows()[1]();
    expect(runs).toBe(2);
    items.mutate((a) => (a.push(3), a));
    rows()[0]();
    rows()[1]();
    expect(runs).toBe(2);
  });
});

describe('mapArray: an item whose key is undefined', () => {
  type Row = { readonly id?: string };
  const setup = (initial: Row[]) => {
    const src = signal<Row[]>(initial);
    const built: (string | undefined)[] = [];
    const destroyed: (string | undefined)[] = [];
    const dups: unknown[][] = [];
    const out = mapArray(
      src,
      (item, index) => {
        built.push(item().id);
        return { id: item().id, index };
      },
      {
        key: (r) => r.id,
        onDestroy: (e) => destroyed.push(e.id),
        onDuplicates: (k) => dups.push([...k]),
      },
    );
    const view = () => out().map((e) => [e.id, e.index()]);
    return { src, out, built, destroyed, dups, view };
  };

  it('a sole undefined key is not a duplicate and its handle is raw', () => {
    const handles: unknown[] = [];
    const src = signal<Row[]>([{ id: 'x' }, {}]);
    const dups: unknown[] = [];
    const out = mapArray<Row, number, string | undefined>(
      src,
      (_i, _x, _k, h) => handles.push(h),
      {
        key: (r) => r.id,
        onDuplicates: (k) => dups.push(k),
      },
    );
    out();
    expect(handles).toEqual(['x', undefined]);
    expect(dups).toEqual([]);
  });

  it('appending maps it', () => {
    const t = setup([{ id: 'x' }]);
    t.out();
    t.src.set([{ id: 'x' }, {}]);
    expect(t.view()).toEqual([
      ['x', 0],
      [undefined, 1],
    ]);
    expect(t.built).toEqual(['x', undefined]);
  });

  it('prepending maps it and keeps the rest', () => {
    const t = setup([{ id: 'a' }]);
    const first = t.out()[0];
    t.src.set([{}, { id: 'a' }]);
    expect(t.view()).toEqual([
      [undefined, 0],
      ['a', 1],
    ]);
    expect(t.out()[1]).toBe(first);
    expect(t.out.reorders()).toBeNull();
  });

  it('removing it from the middle or the front destroys exactly it', () => {
    const mid = setup([{ id: 'a' }, {}, { id: 'b' }]);
    mid.out();
    mid.src.set([{ id: 'a' }, { id: 'b' }]);
    expect(mid.view()).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    expect(mid.destroyed).toEqual([undefined]);

    const front = setup([{}, { id: 'a' }]);
    front.out();
    front.src.set([{ id: 'a' }]);
    expect(front.view()).toEqual([['a', 0]]);
    expect(front.destroyed).toEqual([undefined]);
  });

  it('inserting or removing it alone is not a reorder', () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    t.out.reorders();
    t.src.set([{ id: 'a' }, {}, { id: 'b' }, { id: 'c' }]);
    expect(t.out.reorders()).toBeNull();
    t.src.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(t.out.reorders()).toBeNull();
  });

  it('consecutive duplicate-free states never report duplicates', () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    t.out();
    t.src.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    t.out();
    t.src.set([{ id: 'c' }, { id: 'a' }]);
    t.out();
    expect(t.dups).toEqual([]);
    t.src.set([{ id: 'a' }, { id: 'a' }]);
    t.out();
    expect(t.dups).toEqual([['a']]);
  });
});
