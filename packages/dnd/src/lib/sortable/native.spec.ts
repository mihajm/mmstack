import { computed, effect, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { indicatorEdge } from './native';

describe('indicatorEdge (native render fold)', () => {
  // a 3-item list, lastIndex = 2
  const last = 2;

  it('shows no line when the list is not the active target', () => {
    expect(indicatorEdge(null, 0, last, 'y')).toBeNull();
    expect(indicatorEdge(null, 2, last, 'y')).toBeNull();
  });

  it('draws the line BEFORE the item at the insert index (top, vertical)', () => {
    expect(indicatorEdge(0, 0, last, 'y')).toBe('top'); // insert 0 → before item 0
    expect(indicatorEdge(1, 1, last, 'y')).toBe('top'); // insert 1 → before item 1
    expect(indicatorEdge(2, 2, last, 'y')).toBe('top'); // insert 2 → before item 2
  });

  it('only the END insert (=== length) shows AFTER the last item (bottom)', () => {
    expect(indicatorEdge(3, 2, last, 'y')).toBe('bottom'); // insert 3 on a len-3 list
    // a non-last item never shows bottom (its successor shows top instead)
    expect(indicatorEdge(1, 0, last, 'y')).toBeNull();
  });

  it('exactly one item lights up per insert index (the fold — no double line)', () => {
    const lit = (ins: number) =>
      [0, 1, 2].filter((i) => indicatorEdge(ins, i, last, 'y') !== null);
    expect(lit(0)).toEqual([0]);
    expect(lit(1)).toEqual([1]);
    expect(lit(2)).toEqual([2]);
    expect(lit(3)).toEqual([2]); // end case → last item's bottom
  });

  it('uses left/right on the horizontal axis', () => {
    expect(indicatorEdge(0, 0, last, 'x')).toBe('left');
    expect(indicatorEdge(3, 2, last, 'x')).toBe('right');
  });

  it('empty list: insert 0 on lastIndex -1 → no item to light (container handles it)', () => {
    // with no items, lastIndex is -1; index loop is empty, so nothing lights here
    expect(indicatorEdge(0, 0, -1, 'y')).toBe('top'); // (defensive: index 0 still maps)
  });
});

describe('indicatorEdge — fold reactivity (per-item recompute is minimal)', () => {
  it('moving the insert re-notifies ONLY the items whose edge actually changes', () => {
    const insert = signal<number | null>(null);
    const last = 3;
    const runs = [0, 0, 0, 0];
    TestBed.runInInjectionContext(() => {
      for (let i = 0; i < 4; i++) {
        const edge = computed(() => indicatorEdge(insert(), i, last, 'y'));
        effect(() => {
          edge();
          runs[i]++;
        });
      }
    });
    TestBed.tick(); // initial run → all null, runs = [1,1,1,1]
    expect(runs).toEqual([1, 1, 1, 1]);

    insert.set(1); // item 1 lights (top); 0/2/3 stay null
    TestBed.tick();
    insert.set(2); // item 1 → null, item 2 → top; 0/3 stay null
    TestBed.tick();

    // item 0 was always null → never re-notified past the initial run
    expect(runs[0]).toBe(1);
    // item 3 was always null (insert never reached 3/4) → never re-notified
    expect(runs[3]).toBe(1);
    // items 1 and 2 changed → they DID re-notify (fold is live for the affected rows)
    expect(runs[1]).toBeGreaterThan(1);
    expect(runs[2]).toBeGreaterThan(1);
  });
});
