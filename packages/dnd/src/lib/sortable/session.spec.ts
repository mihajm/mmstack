import { effect, Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type DragGeometry,
  type LinearDragGeometry,
  sortableSession,
} from './session';

const GEOM: LinearDragGeometry = {
  source: 0,
  centers: [10, 30, 50, 70, 90], // pitch 20
  footprint: 20,
  axis: 'y',
};

// 3×2 wrap grid in reading order, pitch 20 both ways (see geometry.spec.ts)
const WRAP_GEOM: DragGeometry = {
  kind: 'wrap',
  source: 0,
  centers: [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 50, y: 10 },
    { x: 10, y: 30 },
    { x: 30, y: 30 },
    { x: 50, y: 30 },
  ],
  colPitch: 20,
  rowPitch: 20,
};

function setup(injector: Injector) {
  const geometry: WritableSignal<DragGeometry | null> = signal(null);
  const pointer = signal(0);
  const pointerCross = signal(0);
  const active = signal(false);
  const session = sortableSession({ geometry, pointer, pointerCross, active });

  // begin a drag of item 0 with the pointer on its center
  const begin = () => {
    geometry.set(GEOM);
    pointer.set(GEOM.centers[GEOM.source]);
    active.set(true);
  };
  // begin a wrap drag of item 0 with the pointer on its center (main = y, cross = x)
  const beginWrap = (source = 0) => {
    const centers = WRAP_GEOM.kind === 'wrap' ? WRAP_GEOM.centers : [];
    geometry.set({ ...WRAP_GEOM, source } as DragGeometry);
    pointer.set(centers[source].y);
    pointerCross.set(centers[source].x);
    active.set(true);
  };
  // count how many times `read()`'s value actually propagates to an effect
  const counter = (read: () => unknown) => {
    let runs = 0;
    effect(() => {
      read();
      runs++;
    }, { injector });
    return {
      get runs() {
        return runs;
      },
      reset() {
        runs = 0;
      },
    };
  };

  return {
    geometry,
    pointer,
    pointerCross,
    active,
    session,
    begin,
    beginWrap,
    counter,
  };
}

describe('sortableSession', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('is inert when idle: insertIndex -1, displacements 0, isSource false', () => {
    const { session } = setup(injector);
    const idx = signal(2);
    expect(session.insertIndex()).toBe(-1);
    expect(session.source()).toBe(-1);
    expect(session.displacementFor(idx)()).toBe(0);
    expect(session.isSource(idx)()).toBe(false);
  });

  it('seeds the insert index at the source when a drag begins', () => {
    const { session, begin } = setup(injector);
    begin();
    expect(session.insertIndex()).toBe(0); // source index
    expect(session.source()).toBe(0);
    expect(session.isSource(signal(0))()).toBe(true);
    expect(session.isSource(signal(2))()).toBe(false);
  });

  it('only flips the insert index when the pointer clears a center (equality-gated)', () => {
    const { session, pointer, begin, counter } = setup(injector);
    begin();
    const ins = counter(() => session.insertIndex());
    TestBed.tick();
    ins.reset();

    pointer.set(25); // still within slot 0 → no flip
    TestBed.tick();
    expect(ins.runs).toBe(0);
    expect(session.insertIndex()).toBe(0);

    pointer.set(35); // passed center of item 1 → insert 1
    TestBed.tick();
    expect(ins.runs).toBe(1);
    expect(session.insertIndex()).toBe(1);
  });

  it('writes the DOM only for items that actually move (fine-grained per-item)', () => {
    const { session, pointer, begin, counter } = setup(injector);
    begin();

    const i2 = session.displacementFor(signal(2));
    const moves2 = counter(() => i2());
    TestBed.tick();
    moves2.reset();

    pointer.set(25); // insert 0→0: item 2 unaffected
    TestBed.tick();
    expect(moves2.runs).toBe(0);
    expect(i2()).toBe(0);

    pointer.set(35); // insert 0→1: item 1 moves, item 2 does NOT
    TestBed.tick();
    expect(moves2.runs).toBe(0);
    expect(i2()).toBe(0);

    pointer.set(55); // insert 1→2: now item 2 moves (0 → -20)
    TestBed.tick();
    expect(moves2.runs).toBe(1);
    expect(i2()).toBe(-20);

    pointer.set(75); // insert 2→3: item 2 already displaced, stays -20
    TestBed.tick();
    expect(moves2.runs).toBe(1); // no extra DOM write
    expect(i2()).toBe(-20);
  });

  it('resets to inert when the drag ends', () => {
    const { session, pointer, active, begin } = setup(injector);
    begin();
    pointer.set(75);
    TestBed.tick();
    expect(session.insertIndex()).toBe(3);

    active.set(false);
    TestBed.tick();
    expect(session.insertIndex()).toBe(-1);
    expect(session.displacementFor(signal(2))()).toBe(0);
    expect(session.isSource(signal(0))()).toBe(false);
  });

  it('linear collision never depends on the cross-axis pointer (no wasted recompute)', () => {
    const { session, pointerCross, begin, counter } = setup(injector);
    begin();
    const ins = counter(() => session.insertIndex());
    TestBed.tick();
    ins.reset();

    pointerCross.set(500); // off-axis wiggle under a LINEAR drag
    TestBed.tick();
    expect(ins.runs).toBe(0); // not even the linkedSignal source recomputed for it
    expect(session.insertIndex()).toBe(0);
  });
});

describe('sortableSession — wrap geometry', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('seeds at the source and is inert until the pointer leaves its Voronoi cell', () => {
    const { session, pointer, pointerCross, beginWrap, counter } =
      setup(injector);
    beginWrap();
    expect(session.insertIndex()).toBe(0);

    const ins = counter(() => session.insertIndex());
    TestBed.tick();
    ins.reset();

    pointer.set(14); // within slot 0's cell
    pointerCross.set(16);
    TestBed.tick();
    expect(ins.runs).toBe(0);
    expect(session.insertIndex()).toBe(0);
  });

  it('crossing a row boundary lands the reading-order slot', () => {
    const { session, pointer, pointerCross, beginWrap } = setup(injector);
    beginWrap();

    pointerCross.set(30); // onto item 4's center: next row, middle column
    pointer.set(30);
    TestBed.tick();
    expect(session.insertIndex()).toBe(4);
  });

  it('slotFor renotifies only the band an insert change touches', () => {
    const { session, pointer, pointerCross, beginWrap, counter } =
      setup(injector);
    beginWrap();

    const slot2 = session.slotFor(signal(2));
    const slot5 = session.slotFor(signal(5));
    const runs2 = counter(() => slot2());
    const runs5 = counter(() => slot5());
    TestBed.tick();
    runs2.reset();
    runs5.reset();

    pointerCross.set(30); // insert 0 → 4: items 1..4 close ranks, item 5 stays
    pointer.set(30);
    TestBed.tick();
    expect(slot2()).toBe(1);
    expect(runs2.runs).toBe(1);
    expect(slot5()).toBe(5);
    expect(runs5.runs).toBe(0); // outside the band: same int, no notify

    pointerCross.set(50); // insert 4 → 5: item 5 now joins the band
    pointer.set(30);
    TestBed.tick();
    expect(slot5()).toBe(4);
    expect(runs5.runs).toBe(1);
    expect(slot2()).toBe(1); // still one slot back
    expect(runs2.runs).toBe(1); // untouched by the second flip
  });

  it('slotFor is the identity while idle and after the drag ends', () => {
    const { session, active, beginWrap } = setup(injector);
    const idx = signal(3);
    expect(session.slotFor(idx)()).toBe(3);

    beginWrap();
    active.set(false);
    TestBed.tick();
    expect(session.slotFor(idx)()).toBe(3);
  });

  it('displacementFor stays 0 under wrap geometry (slot model owns transforms)', () => {
    const { session, pointer, pointerCross, beginWrap } = setup(injector);
    beginWrap();
    pointerCross.set(30);
    pointer.set(30);
    TestBed.tick();
    expect(session.insertIndex()).toBe(4);
    expect(session.displacementFor(signal(2))()).toBe(0);
  });
});
