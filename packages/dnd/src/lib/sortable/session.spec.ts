import { effect, Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type DragGeometry, sortableSession } from './session';

const GEOM: DragGeometry = {
  source: 0,
  centers: [10, 30, 50, 70, 90], // pitch 20
  footprint: 20,
  axis: 'y',
};

function setup(injector: Injector) {
  const geometry: WritableSignal<DragGeometry | null> = signal(null);
  const pointer = signal(0);
  const active = signal(false);
  const session = sortableSession({ geometry, pointer, active });

  // begin a drag of item 0 with the pointer on its center
  const begin = () => {
    geometry.set(GEOM);
    pointer.set(GEOM.centers[GEOM.source]);
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

  return { geometry, pointer, active, session, begin, counter };
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
});
