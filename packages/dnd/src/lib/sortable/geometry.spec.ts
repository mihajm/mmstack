import {
  centerAlong,
  clampInsert,
  closeDisplacement,
  containsPoint,
  displacement,
  openDisplacement,
  insertIndexFromCenters,
  insertIndexTransformAware,
  moveWithin,
  sizeAlong,
  startAlong,
  transfer,
  type RectLike,
} from './geometry';

const rect = (p: Partial<RectLike>): RectLike => ({
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  ...p,
});

describe('geometry — axis projectors', () => {
  const r = rect({ top: 10, left: 20, width: 100, height: 40 });

  it('projects start/size/center onto each axis', () => {
    expect(startAlong(r, 'x')).toBe(20);
    expect(startAlong(r, 'y')).toBe(10);
    expect(sizeAlong(r, 'x')).toBe(100);
    expect(sizeAlong(r, 'y')).toBe(40);
    expect(centerAlong(r, 'x')).toBe(70); // 20 + 100/2
    expect(centerAlong(r, 'y')).toBe(30); // 10 + 40/2
  });
});

describe('geometry — insertIndexFromCenters', () => {
  // four items, centers at 10/30/50/70 (size 20, contiguous)
  const centers = [10, 30, 50, 70];

  it('returns 0 before the first center and length after the last', () => {
    expect(insertIndexFromCenters(centers, -100)).toBe(0);
    expect(insertIndexFromCenters(centers, 0)).toBe(0);
    expect(insertIndexFromCenters(centers, 1000)).toBe(4);
  });

  it('counts the centers the pointer has passed (gap-safe in dead space)', () => {
    expect(insertIndexFromCenters(centers, 20)).toBe(1); // between c0 and c1
    expect(insertIndexFromCenters(centers, 40)).toBe(2); // between c1 and c2
    expect(insertIndexFromCenters(centers, 60)).toBe(3); // between c2 and c3
  });

  it('treats a pointer exactly on a center as "not yet passed" (insert before)', () => {
    expect(insertIndexFromCenters(centers, 10)).toBe(0);
    expect(insertIndexFromCenters(centers, 30)).toBe(1);
    expect(insertIndexFromCenters(centers, 70)).toBe(3);
  });

  it('handles empty and single-item lists', () => {
    expect(insertIndexFromCenters([], 5)).toBe(0);
    expect(insertIndexFromCenters([50], 0)).toBe(0);
    expect(insertIndexFromCenters([50], 50)).toBe(0); // on center → before
    expect(insertIndexFromCenters([50], 51)).toBe(1); // past center → after
  });

  it('is monotonic non-decreasing in pointer position (jank invariant)', () => {
    let prev = -1;
    for (let pos = -20; pos <= 100; pos++) {
      const idx = insertIndexFromCenters(centers, pos);
      expect(idx).toBeGreaterThanOrEqual(prev);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(centers.length);
      prev = idx;
    }
  });
});

describe('geometry — displacement (FLIP transform)', () => {
  const N = 5;
  const FOOT = 53; // source footprint = size + gap

  it('the source itself never gets a displacement (pointer drives it)', () => {
    expect(displacement(2, 2, 0, FOOT)).toBe(0);
    expect(displacement(2, 2, 4, FOOT)).toBe(0);
  });

  it('moving DOWN shifts the items it passes up by the source footprint', () => {
    // source 1 → insert 3: items 2,3 shift up by footprint; 0,4 untouched
    expect(displacement(0, 1, 3, FOOT)).toBe(0);
    expect(displacement(2, 1, 3, FOOT)).toBe(-FOOT);
    expect(displacement(3, 1, 3, FOOT)).toBe(-FOOT);
    expect(displacement(4, 1, 3, FOOT)).toBe(0);
  });

  it('moving UP shifts the items it passes down by the source footprint', () => {
    // source 3 → insert 1: items 1,2 shift down by footprint; 0,4 untouched
    expect(displacement(0, 3, 1, FOOT)).toBe(0);
    expect(displacement(1, 3, 1, FOOT)).toBe(FOOT);
    expect(displacement(2, 3, 1, FOOT)).toBe(FOOT);
    expect(displacement(4, 3, 1, FOOT)).toBe(0);
  });

  it('a no-op (insert === source) displaces nothing', () => {
    for (let i = 0; i < N; i++) expect(displacement(i, 2, 2, FOOT)).toBe(0);
  });

  it('shifts every sibling by the SAME footprint — exact for variable sizes', () => {
    // The shift is the source's footprint, not the sibling's own size, so a
    // variable-width sibling still lands on its committed slot (no X-axis jerk).
    // e.g. siblings of widths 20/30/40 all shift by the source's 15px footprint.
    expect(displacement(1, 0, 3, 15)).toBe(-15);
    expect(displacement(2, 0, 3, 15)).toBe(-15);
    expect(displacement(3, 0, 3, 15)).toBe(-15);
  });

  it('conserves layout: each moved sibling fills the one source-sized hole', () => {
    // total sibling shift = footprint × (slots traversed), opposite the source.
    const cases = [
      { source: 1, insert: 4 },
      { source: 4, insert: 0 },
      { source: 2, insert: 2 },
      { source: 0, insert: 3 },
    ];
    for (const { source, insert } of cases) {
      let shifted = 0;
      for (let i = 0; i < N; i++) shifted += displacement(i, source, insert, FOOT);
      const dist = insert - source;
      expect(shifted).toBe(dist === 0 ? 0 : -Math.sign(dist) * Math.abs(dist) * FOOT);
    }
  });
});

describe('geometry — insertIndexTransformAware (FLIP collision)', () => {
  // five contiguous items, centers 10/30/50/70/90, footprint 20 (= pitch here)
  const centers = [10, 30, 50, 70, 90];
  const FOOT = 20;
  const N = centers.length;

  // settle the recurrence prevInsert ← f(prevInsert) for a held pointer position
  const settle = (pos: number, source: number, deadband: number) => {
    let prev = source;
    const trail: number[] = [prev];
    for (let step = 0; step < 50; step++) {
      const next = insertIndexTransformAware(centers, source, FOOT, pos, prev, deadband);
      trail.push(next);
      if (next === prev) return { fixed: true, value: next, trail };
      prev = next;
    }
    return { fixed: false, value: prev, trail }; // never settled → oscillation
  };

  it('seeded at the source with the pointer on its center is a no-op (returns source)', () => {
    for (let source = 0; source < N; source++) {
      expect(
        insertIndexTransformAware(centers, source, FOOT, centers[source], source),
      ).toBe(source);
    }
  });

  it('stays within [0, N-1] — it is a reorder, never an append', () => {
    for (let source = 0; source < N; source++) {
      for (let pos = -50; pos <= 150; pos += 3) {
        for (let prev = 0; prev < N; prev++) {
          const k = insertIndexTransformAware(centers, source, FOOT, pos, prev);
          expect(k).toBeGreaterThanOrEqual(0);
          expect(k).toBeLessThanOrEqual(N - 1);
        }
      }
    }
  });

  it('a monotonic drag yields a monotonic insert index (no backward flicker)', () => {
    const source = 0;
    let prev = source;
    let last = -1;
    for (let pos = -20; pos <= 140; pos += 2) {
      prev = insertIndexTransformAware(centers, source, FOOT, pos, prev, 4);
      expect(prev).toBeGreaterThanOrEqual(last); // never decreases as pointer advances
      last = prev;
    }
    expect(last).toBe(N - 1); // dragged past the end → lands last
  });

  it('a monotonic upward drag yields a non-increasing insert index', () => {
    const source = N - 1;
    let prev = source;
    let last = N; // start above the max
    for (let pos = 140; pos >= -20; pos -= 2) {
      prev = insertIndexTransformAware(centers, source, FOOT, pos, prev, 4);
      expect(prev).toBeLessThanOrEqual(last);
      last = prev;
    }
    expect(last).toBe(0); // dragged past the start → lands first
  });

  it('CONVERGES for every held pointer position — no period-2 oscillation (the jank guard)', () => {
    // For any stationary pointer, iterating prevInsert ← f(prevInsert) must
    // reach a fixed point. This holds even with deadband 0: keeping the source
    // in flow keeps the cached centers valid, so the displaced-center fold is
    // self-consistent and settles — that's the FLIP design defeating the shake
    // at its root cause, not the deadband papering over it.
    for (const deadband of [0, 4]) {
      for (let source = 0; source < N; source++) {
        for (let pos = -10; pos <= 110; pos++) {
          expect(settle(pos, source, deadband).fixed).toBe(true);
        }
      }
    }
  });

  it('the deadband widens the flip threshold by exactly `deadband` px (jitter immunity)', () => {
    // Its real job: a center must be cleared by `deadband` more before the index
    // flips, so sub-pixel pointer jitter near a boundary can't twitch the order.
    const source = 0;
    const prev = 2;
    const advanceThreshold = (d: number) => {
      for (let pos = -20; pos <= 140; pos++) {
        if (insertIndexTransformAware(centers, source, FOOT, pos, prev, d) > prev) {
          return pos;
        }
      }
      return Infinity;
    };
    expect(advanceThreshold(6) - advanceThreshold(0)).toBe(6);
  });

  it('agrees with the move it implies: committing settle() reproduces the FLIP order', () => {
    // The collision index, fed to moveWithin, must produce exactly the order the
    // displaced layout was showing — collision and commit never disagree.
    const source = 1;
    const labels = ['a', 'b', 'c', 'd', 'e'];
    const { value } = settle(85, source, 4); // drag 'b' toward the end
    const reordered = moveWithin(labels, source, value);
    expect(reordered).toHaveLength(N);
    expect(new Set(reordered)).toEqual(new Set(labels));
    expect(reordered.indexOf('b')).toBe(value);
  });
});

describe('geometry — close/openDisplacement (cross-list asymmetry)', () => {
  const FOOT = 30;

  it('closeDisplacement: source list closes the gap behind the departed item', () => {
    // item left index 1 → items 2,3,4 shift back by footprint; 0,1 untouched
    expect(closeDisplacement(0, 1, FOOT)).toBe(0);
    expect(closeDisplacement(1, 1, FOOT)).toBe(0); // the leaving item (pointer-driven)
    expect(closeDisplacement(2, 1, FOOT)).toBe(-FOOT);
    expect(closeDisplacement(4, 1, FOOT)).toBe(-FOOT);
  });

  it('openDisplacement: target list opens a gap at/after the insert', () => {
    // entering at index 2 → items 2,3,.. open by footprint; 0,1 untouched
    expect(openDisplacement(0, 2, FOOT)).toBe(0);
    expect(openDisplacement(1, 2, FOOT)).toBe(0);
    expect(openDisplacement(2, 2, FOOT)).toBe(FOOT);
    expect(openDisplacement(3, 2, FOOT)).toBe(FOOT);
  });

  it('insert at the end opens nothing (append); insert at 0 opens everything', () => {
    const n = 4;
    let openedAtEnd = 0;
    for (let i = 0; i < n; i++) openedAtEnd += openDisplacement(i, n, FOOT) === FOOT ? 1 : 0;
    expect(openedAtEnd).toBe(0); // append → no item shifts
    let openedAtStart = 0;
    for (let i = 0; i < n; i++) openedAtStart += openDisplacement(i, 0, FOOT) === FOOT ? 1 : 0;
    expect(openedAtStart).toBe(n); // all shift
  });

  it('cross-list APPEND end-to-end: collision → N, no gap opens, transfer appends', () => {
    // pointer past the last center of a 3-item target (a bounded container's tail)
    const targetCenters = [10, 30, 50];
    const n = targetCenters.length;
    const insert = insertIndexFromCenters(targetCenters, 1000);
    expect(insert).toBe(n); // append index (N, beyond the last item) — not capped at N-1

    for (let i = 0; i < n; i++) expect(openDisplacement(i, insert, FOOT)).toBe(0); // nothing moves
    const { to } = transfer(['dragged'], 0, ['t0', 't1', 't2'], insert);
    expect(to).toEqual(['t0', 't1', 't2', 'dragged']); // landed at the end
  });
});

describe('geometry — containsPoint (cross-list target hit-test)', () => {
  const box: RectLike = { top: 100, left: 50, width: 200, height: 80 };

  it('is true strictly inside and on the edges, false outside', () => {
    expect(containsPoint(box, 150, 140)).toBe(true); // inside
    expect(containsPoint(box, 50, 100)).toBe(true); // top-left corner
    expect(containsPoint(box, 250, 180)).toBe(true); // bottom-right corner
    expect(containsPoint(box, 49, 140)).toBe(false); // left of
    expect(containsPoint(box, 251, 140)).toBe(false); // right of
    expect(containsPoint(box, 150, 99)).toBe(false); // above
    expect(containsPoint(box, 150, 181)).toBe(false); // below
  });
});

describe('geometry — transfer (cross-list move)', () => {
  const a = ['a0', 'a1', 'a2'];
  const b = ['b0', 'b1'];

  it('removes from source and inserts into target at the index', () => {
    const r = transfer(a, 1, b, 1);
    expect(r.item).toBe('a1');
    expect(r.from).toEqual(['a0', 'a2']); // -1
    expect(r.to).toEqual(['b0', 'a1', 'b1']); // +1 at index 1
  });

  it('clamps the target index and can append', () => {
    expect(transfer(a, 0, b, 99).to).toEqual(['b0', 'b1', 'a0']);
    expect(transfer(a, 0, b, -5).to).toEqual(['a0', 'b0', 'b1']);
  });

  it('conserves the combined item set (no loss / no duplication)', () => {
    const r = transfer(a, 2, b, 0);
    expect([...r.from, ...r.to].sort()).toEqual([...a, ...b].sort());
    expect(r.from).toHaveLength(a.length - 1);
    expect(r.to).toHaveLength(b.length + 1);
  });

  it('does not mutate the inputs', () => {
    const ac = a.slice();
    const bc = b.slice();
    transfer(a, 0, b, 0);
    expect(a).toEqual(ac);
    expect(b).toEqual(bc);
  });

  it('is a no-op (copies, no item) when fromIndex is out of range', () => {
    const r = transfer(a, 5, b, 0);
    expect(r.item).toBeUndefined();
    expect(r.from).toEqual(a);
    expect(r.to).toEqual(b);
  });
});

describe('geometry — moveWithin & clampInsert', () => {
  const base = ['a', 'b', 'c', 'd'];

  it('clamps insert positions into [0, length]', () => {
    expect(clampInsert(-5, 4)).toBe(0);
    expect(clampInsert(2, 4)).toBe(2);
    expect(clampInsert(9, 4)).toBe(4);
  });

  it('moves an item to a later / earlier index', () => {
    expect(moveWithin(base, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveWithin(base, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when the item already sits at the target', () => {
    expect(moveWithin(base, 1, 1)).toEqual(base);
  });

  it('does not mutate the source array', () => {
    const copy = base.slice();
    moveWithin(base, 0, 3);
    expect(base).toEqual(copy);
  });

  it('preserves length and the full key set for every (from,to) pair', () => {
    const key = (s: string) => s;
    for (let from = 0; from < base.length; from++) {
      for (let to = 0; to < base.length; to++) {
        const out = moveWithin(base, from, to);
        expect(out).toHaveLength(base.length);
        expect(new Set(out.map(key))).toEqual(new Set(base.map(key)));
      }
    }
  });
});
