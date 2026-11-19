import { effect, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CanvasFrame, GridSpec } from './geometry';
import {
  canvasSession,
  IDENTITY_TRANSFORM,
  type CanvasGesture,
  type CanvasSessionConfig,
  type CanvasSpaceTransform,
} from './session';

const frame = (x: number, y: number, width = 40, height = 40): CanvasFrame => ({
  x,
  y,
  width,
  height,
});

type MoveGesture = Extract<CanvasGesture<string>, { kind: 'move' }>;

function setup(injector: Injector, cfg: Partial<CanvasSessionConfig> = {}) {
  const gesture = signal<CanvasGesture<string> | null>(null);
  const pointerX = signal(0);
  const pointerY = signal(0);
  const modShift = signal(false);
  const modCtrl = signal(false);
  const modAlt = signal(false);
  const scrollDeltaX = signal(0);
  const scrollDeltaY = signal(0);
  const space = signal<CanvasSpaceTransform>(IDENTITY_TRANSFORM);
  const grid = signal<GridSpec | undefined>(undefined);

  const session = canvasSession<string>({
    gesture,
    pointerX,
    pointerY,
    modShift,
    modCtrl,
    modAlt,
    scrollDeltaX,
    scrollDeltaY,
    space,
    config: {
      grid,
      bounds: () => undefined,
      snap: () => true,
      snapThreshold: () => 6,
      snapToCanvas: () => false,
      lockAxisOnShift: () => true,
      resizeMin: () => undefined,
      resizeMax: () => undefined,
      rotateSnap: () => 15,
      ...cfg,
    },
  });

  // a single item 'a' at (100, 100) 40×40; a snap sibling at (160, 100)
  const beginMove = (opts: Partial<MoveGesture> = {}) => {
    pointerX.set(120);
    pointerY.set(120);
    gesture.set({
      kind: 'move',
      keys: ['a'],
      baseFrames: new Map([['a', frame(100, 100)]]),
      union: frame(100, 100),
      snapTargets: [],
      containers: [],
      start: { x: 120, y: 120 },
      surfaceOrigin: { x: 0, y: 0 },
      ...opts,
    });
  };

  const counter = (read: () => unknown) => {
    let runs = 0;
    effect(
      () => {
        read();
        runs++;
      },
      { injector },
    );
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
    gesture,
    pointerX,
    pointerY,
    modShift,
    modCtrl,
    modAlt,
    scrollDeltaX,
    scrollDeltaY,
    space,
    grid,
    session,
    beginMove,
    counter,
  };
}

describe('canvasSession', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('is inert when idle — pointer movement recomputes nothing', () => {
    const { session, pointerX, pointerY, counter } = setup(injector);
    const delta = counter(() => session.overlayDeltaX());
    const guides = counter(() => session.guides());
    const rect = counter(() => session.marqueeRect());
    const hover = counter(() => session.hoverContainer());
    TestBed.tick();
    delta.reset();
    guides.reset();
    rect.reset();
    hover.reset();

    pointerX.set(500);
    pointerY.set(500);
    TestBed.tick();
    expect(delta.runs).toBe(0);
    expect(guides.runs).toBe(0);
    expect(rect.runs).toBe(0);
    expect(hover.runs).toBe(0);
    expect(session.active()).toBe(false);
    expect(session.kind()).toBeNull();
  });

  describe('move', () => {
    it('the overlay delta follows the pointer', () => {
      const { session, pointerX, pointerY, beginMove } = setup(injector);
      beginMove();
      pointerX.set(135);
      pointerY.set(110);
      expect(session.overlayDeltaX()).toBe(15);
      expect(session.overlayDeltaY()).toBe(-10);
    });

    it('grid-quantized: pointer movement within a cell does not renotify', () => {
      const { session, pointerX, grid, beginMove, counter } = setup(injector);
      grid.set({ size: 10 });
      beginMove();
      const dx = counter(() => session.overlayDeltaX());
      TestBed.tick();
      dx.reset();

      pointerX.set(123); // 100+23 → snaps to 120: same origin as start
      TestBed.tick();
      expect(dx.runs).toBe(0);
      expect(session.overlayDeltaX()).toBe(0);

      pointerX.set(126); // snaps to 130 → +10
      TestBed.tick();
      expect(dx.runs).toBe(1);
      expect(session.overlayDeltaX()).toBe(10);
    });

    it('Shift axis-locks to the dominant axis', () => {
      const { session, pointerX, pointerY, modShift, beginMove } =
        setup(injector);
      beginMove();
      modShift.set(true);
      pointerX.set(150);
      pointerY.set(128);
      expect(session.overlayDeltaX()).toBe(30);
      expect(session.overlayDeltaY()).toBe(0);
    });

    it('snaplines pull the union to a sibling edge and expose guides', () => {
      const { session, pointerX, beginMove } = setup(injector);
      beginMove({ snapTargets: [frame(160, 100, 40, 40)] });
      pointerX.set(138); // raw x 118 → right edge 158, sibling left 160 → snap +2
      expect(session.overlayDeltaX()).toBe(20);
      expect(session.guides().length).toBeGreaterThan(0);
    });

    it('guides are value-stable: unchanged lines do not renotify', () => {
      const { session, pointerY, pointerX, beginMove, counter } =
        setup(injector);
      beginMove({ snapTargets: [frame(160, 100, 40, 40)] });
      pointerX.set(138); // snapped against the sibling's left edge
      const guides = counter(() => session.guides());
      TestBed.tick();
      guides.reset();

      pointerX.set(139); // still within snap range → same snapped position
      TestBed.tick();
      expect(guides.runs).toBe(0);

      pointerY.set(500); // dragged far: vertical alignment breaks → guides change
      TestBed.tick();
      expect(guides.runs).toBe(1);
    });

    it('Ctrl bypasses grid and snaplines', () => {
      const { session, pointerX, modCtrl, grid, beginMove } = setup(injector);
      grid.set({ size: 10 });
      beginMove({ snapTargets: [frame(160, 100, 40, 40)] });
      modCtrl.set(true);
      pointerX.set(138);
      expect(session.overlayDeltaX()).toBe(18); // raw, no grid, no snapline
      expect(session.guides()).toEqual([]);
    });

    it('Alt has no effect on a move (no wasted recompute)', () => {
      const { session, modAlt, beginMove, counter } = setup(injector);
      beginMove();
      const dx = counter(() => session.overlayDeltaX());
      TestBed.tick();
      dx.reset();
      modAlt.set(true);
      TestBed.tick();
      expect(dx.runs).toBe(0);
    });

    it('resolves the innermost accepting container, renotifying on change only', () => {
      const { session, pointerX, beginMove, counter } = setup(injector);
      beginMove({
        containers: [
          { key: 'outer', box: frame(0, 0, 400, 400) },
          { key: 'inner', box: frame(200, 100, 100, 100) },
        ],
      });
      const hover = counter(() => session.hoverContainer());
      TestBed.tick();
      expect(session.hoverContainer()).toBe('outer');
      hover.reset();

      pointerX.set(150); // still in outer only
      TestBed.tick();
      expect(hover.runs).toBe(0);

      pointerX.set(250); // now inside inner (and outer) → innermost wins
      TestBed.tick();
      expect(session.hoverContainer()).toBe('inner');
      expect(hover.runs).toBe(1);

      pointerX.set(260); // still inner
      TestBed.tick();
      expect(hover.runs).toBe(1);
    });
  });

  describe('resize', () => {
    const beginResize = (
      s: ReturnType<typeof setup>,
      direction: 'se' | 'e' = 'se',
    ) => {
      s.pointerX.set(140);
      s.pointerY.set(140);
      s.gesture.set({
        kind: 'resize',
        direction,
        keys: ['a'],
        baseFrames: new Map([['a', frame(100, 100)]]),
        union: frame(100, 100),
        snapTargets: [],
        start: { x: 140, y: 140 },
        surfaceOrigin: { x: 0, y: 0 },
      });
    };

    it('resolves the resized union box', () => {
      const s = setup(injector);
      beginResize(s);
      s.pointerX.set(160);
      s.pointerY.set(150);
      expect(s.session.resizeBox()).toEqual({
        x: 100,
        y: 100,
        width: 60,
        height: 50,
      });
    });

    it('Shift holds the aspect ratio, Alt resizes from center', () => {
      const s = setup(injector);
      beginResize(s);
      s.modShift.set(true);
      s.pointerX.set(160); // dominant: +20 width → height follows (1:1)
      s.pointerY.set(145);
      expect(s.session.resizeBox()).toEqual({
        x: 100,
        y: 100,
        width: 60,
        height: 60,
      });

      s.modShift.set(false);
      s.modAlt.set(true);
      s.pointerX.set(150);
      s.pointerY.set(140);
      expect(s.session.resizeBox()).toEqual({
        x: 90,
        y: 100,
        width: 60,
        height: 40,
      });
    });

    it('move-side signals stay silent during a resize', () => {
      const s = setup(injector);
      beginResize(s);
      const dx = s.counter(() => s.session.overlayDeltaX());
      TestBed.tick();
      dx.reset();
      s.pointerX.set(200);
      TestBed.tick();
      expect(dx.runs).toBe(0);
      expect(s.session.overlayDeltaX()).toBe(0);
    });
  });

  describe('rotate', () => {
    it('adds the pointer sweep, snapping on Shift', () => {
      const s = setup(injector);
      s.pointerX.set(150);
      s.pointerY.set(120);
      s.gesture.set({
        kind: 'rotate',
        keys: ['a'],
        baseFrames: new Map([['a', frame(100, 100)]]),
        union: frame(100, 100),
        snapTargets: [],
        start: { x: 150, y: 120 },
        surfaceOrigin: { x: 0, y: 0 },
        pivot: { x: 120, y: 120 },
        baseAngle: 0,
        startPointerAngle: 0,
      });
      s.pointerX.set(120);
      s.pointerY.set(150); // pointer now south of the pivot → 90°
      expect(s.session.angle()).toBe(90);

      s.pointerX.set(124);
      s.pointerY.set(150); // atan2(30, 4) ≈ 82.4° raw
      s.modShift.set(true);
      expect(s.session.angle()).toBe(75); // snapped to 15° increments
    });
  });

  describe('marquee', () => {
    it('yields a normalized live rect in canvas space', () => {
      const s = setup(injector);
      s.pointerX.set(50);
      s.pointerY.set(50);
      s.gesture.set({
        kind: 'marquee',
        keys: [],
        baseFrames: new Map(),
        union: frame(0, 0, 0, 0),
        snapTargets: [],
        start: { x: 50, y: 50 },
        surfaceOrigin: { x: 0, y: 0 },
      });
      s.pointerX.set(20);
      s.pointerY.set(90);
      expect(s.session.marqueeRect()).toEqual({
        x: 20,
        y: 50,
        width: 30,
        height: 40,
      });
    });
  });

  describe('pan/zoom space', () => {
    it('projects the pointer through the live transform (zoom-during-drag)', () => {
      const s = setup(injector);
      s.space.set({ x: 0, y: 0, scale: 2 });
      s.pointerX.set(240);
      s.pointerY.set(240);
      s.gesture.set({
        kind: 'move',
        keys: ['a'],
        baseFrames: new Map([['a', frame(100, 100)]]),
        union: frame(100, 100),
        snapTargets: [],
        containers: [],
        start: { x: 120, y: 120 }, // canvas-space start (240 client / scale 2)
        surfaceOrigin: { x: 0, y: 0 },
      });
      s.pointerX.set(280); // +40 client → +20 canvas at scale 2
      expect(s.session.overlayDeltaX()).toBe(20);

      s.space.set({ x: 0, y: 0, scale: 4 }); // zoom in mid-gesture
      // same client pointer now maps to 280/4 = 70 canvas → delta -50
      expect(s.session.overlayDeltaX()).toBe(-50);
    });

    it('auto-scroll compensation feeds the canvas pointer', () => {
      const s = setup(injector);
      s.beginMove();
      s.scrollDeltaX.set(30);
      expect(s.session.overlayDeltaX()).toBe(30);
    });

    it('scroll compensation is viewport px — it divides through the zoom scale', () => {
      const s = setup(injector);
      s.space.set({ x: 0, y: 0, scale: 2 });
      s.pointerX.set(240);
      s.pointerY.set(240);
      s.gesture.set({
        kind: 'move',
        keys: ['a'],
        baseFrames: new Map([['a', frame(100, 100)]]),
        union: frame(100, 100),
        snapTargets: [],
        containers: [],
        start: { x: 120, y: 120 },
        surfaceOrigin: { x: 0, y: 0 },
      });
      s.scrollDeltaX.set(30); // 30 screen px of scroll at scale 2
      expect(s.session.overlayDeltaX()).toBe(15); // = 15 canvas px, not 30
    });
  });
});

describe('canvasSession: per-kind signals and projections', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  const resizeGesture = (
    direction: 'se' | 'e',
    union = frame(100, 100),
    snapTargets: CanvasFrame[] = [],
  ): CanvasGesture<string> => ({
    kind: 'resize',
    direction,
    keys: ['a'],
    baseFrames: new Map([['a', union]]),
    union,
    snapTargets,
    start: { x: 140, y: 140 },
    surfaceOrigin: { x: 0, y: 0 },
  });

  it('idle: every kind-specific signal is null and the pointer reads 0', () => {
    const s = setup(injector);
    s.pointerX.set(300);
    s.pointerY.set(200);
    expect(s.session.active()).toBe(false);
    expect(s.session.canvasPointerX()).toBe(0);
    expect(s.session.canvasPointerY()).toBe(0);
    expect(s.session.resizeBox()).toBeNull();
    expect(s.session.angle()).toBeNull();
    expect(s.session.marqueeRect()).toBeNull();
  });

  it('a move exposes no resize box, angle or rubber band', () => {
    const s = setup(injector);
    s.beginMove();
    s.pointerX.set(150);
    expect(s.session.active()).toBe(true);
    expect(s.session.kind()).toBe('move');
    expect(s.session.resizeBox()).toBeNull();
    expect(s.session.angle()).toBeNull();
    expect(s.session.marqueeRect()).toBeNull();
  });

  it('a resize reports no hover container and no move delta', () => {
    const s = setup(injector);
    s.pointerX.set(140);
    s.pointerY.set(140);
    s.gesture.set(resizeGesture('se'));
    s.pointerX.set(150);
    expect(s.session.hoverContainer()).toBeNull();
    expect(s.session.angle()).toBeNull();
    expect(s.session.resizeBox()).toEqual(frame(100, 100, 50, 40));
  });

  it('works without a space: the identity transform applies', () => {
    const gesture = signal<CanvasGesture<string> | null>(null);
    const pointerX = signal(120);
    const pointerY = signal(120);
    const session = canvasSession<string>({
      gesture,
      pointerX,
      pointerY,
      modShift: signal(false),
      modCtrl: signal(false),
      modAlt: signal(false),
      scrollDeltaX: signal(0),
      scrollDeltaY: signal(0),
      config: {
        grid: () => undefined,
        bounds: () => undefined,
        snap: () => false,
        snapThreshold: () => 6,
        snapToCanvas: () => false,
        lockAxisOnShift: () => false,
        resizeMin: () => undefined,
        resizeMax: () => undefined,
        rotateSnap: () => undefined,
      },
    });
    gesture.set({
      kind: 'move',
      keys: ['a'],
      baseFrames: new Map([['a', frame(100, 100)]]),
      union: frame(100, 100),
      snapTargets: [],
      containers: [],
      start: { x: 120, y: 120 },
      surfaceOrigin: { x: 0, y: 0 },
    });
    pointerX.set(133);
    pointerY.set(127);
    expect(session.overlayDeltaX()).toBe(13);
    expect(session.overlayDeltaY()).toBe(7);
  });

  it('the canvas pointer subtracts the surface origin and the pan offset', () => {
    const s = setup(injector);
    s.space.set({ x: 30, y: 20, scale: 1 });
    s.beginMove({ surfaceOrigin: { x: 10, y: 5 } });
    s.pointerX.set(200);
    s.pointerY.set(100);
    expect(s.session.canvasPointerX()).toBe(160);
    expect(s.session.canvasPointerY()).toBe(75);
  });

  it('the y axis divides by the scale and adds the scroll delta like x', () => {
    const s = setup(injector);
    s.space.set({ x: 0, y: 0, scale: 2 });
    s.beginMove();
    s.pointerX.set(240);
    s.pointerY.set(280);
    expect(s.session.overlayDeltaY()).toBe(20);
    s.scrollDeltaY.set(20);
    expect(s.session.overlayDeltaY()).toBe(30);
  });

  it('the snap threshold is screen px: at scale 2 a 4 canvas px gap does not snap (move and resize)', () => {
    const s = setup(injector);
    s.space.set({ x: 0, y: 0, scale: 2 });
    s.beginMove({ snapTargets: [frame(160, 0, 40, 40)] });
    s.pointerX.set(240);
    s.pointerY.set(240);
    s.pointerX.set(272); // +16 canvas: right edge 156, target left 160
    expect(s.session.overlayDeltaX()).toBe(16);

    s.gesture.set(null);
    s.pointerX.set(280);
    s.pointerY.set(280);
    s.gesture.set(resizeGesture('e', frame(100, 100), [frame(160, 0, 40, 40)]));
    s.pointerX.set(312);
    expect(s.session.resizeBox()?.width).toBe(56);
  });

  it('Shift on a zero-height resize keeps a finite box (no aspect to hold)', () => {
    const s = setup(injector);
    s.pointerX.set(140);
    s.pointerY.set(100);
    s.gesture.set({
      ...resizeGesture('se', frame(100, 100, 40, 0)),
      start: { x: 140, y: 100 },
    });
    s.modShift.set(true);
    s.pointerX.set(145);
    s.pointerY.set(120);
    expect(s.session.resizeBox()).toEqual(frame(100, 100, 45, 20));
  });

  it('a resize edge near a sibling exposes an x guide', () => {
    const s = setup(injector);
    s.pointerX.set(140);
    s.pointerY.set(140);
    s.gesture.set(resizeGesture('e', frame(100, 100), [frame(160, 300)]));
    s.pointerX.set(158); // right edge 158 → snaps to 160
    expect(s.session.resizeBox()?.width).toBe(60);
    expect(s.session.guides()).toEqual([
      { axis: 'x', position: 160, from: 100, to: 340 },
    ]);
  });
});

describe('canvasSession: guides and hover container', () => {
  let injector: Injector;
  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      injector = TestBed.inject(Injector);
    });
  });

  it('a move with nothing to snap to never renotifies guides', () => {
    const s = setup(injector);
    s.beginMove();
    const guides = s.counter(() => s.session.guides());
    TestBed.tick();
    guides.reset();
    s.pointerX.set(150);
    TestBed.tick();
    s.pointerX.set(170);
    TestBed.tick();
    expect(guides.runs).toBe(0);
  });

  it('going from no guides to some exposes them', () => {
    const s = setup(injector);
    s.beginMove({ snapTargets: [frame(160, 0, 40, 40)] });
    expect(s.session.guides()).toEqual([]);
    s.pointerX.set(138);
    expect(s.session.guides()).toEqual([
      { axis: 'x', position: 160, from: 0, to: 140 },
    ]);
  });

  // one transition per guide field: each change alone must reach the reader
  it.each([
    {
      field: 'to',
      targets: [frame(160, 0, 40, 40)],
      first: { x: 138, y: 120 },
      then: { x: 138, y: 130 },
      before: { axis: 'x', position: 160, from: 0, to: 140 },
      after: { axis: 'x', position: 160, from: 0, to: 150 },
    },
    {
      field: 'from',
      targets: [frame(160, 300, 40, 40)],
      first: { x: 138, y: 120 },
      then: { x: 138, y: 130 },
      before: { axis: 'x', position: 160, from: 100, to: 340 },
      after: { axis: 'x', position: 160, from: 110, to: 340 },
    },
    {
      field: 'position',
      targets: [frame(160, 0, 40, 40), frame(300, 0, 40, 40)],
      first: { x: 138, y: 120 },
      then: { x: 278, y: 120 },
      before: { axis: 'x', position: 160, from: 0, to: 140 },
      after: { axis: 'x', position: 300, from: 0, to: 140 },
    },
  ])('a change in $field alone updates the guide', (t) => {
    const s = setup(injector);
    s.beginMove({ snapTargets: t.targets });
    s.pointerX.set(t.first.x);
    s.pointerY.set(t.first.y);
    expect(s.session.guides()).toEqual([t.before]);
    s.pointerX.set(t.then.x);
    s.pointerY.set(t.then.y);
    expect(s.session.guides()).toEqual([t.after]);
  });

  it('a change in axis alone updates the guide', () => {
    const s = setup(injector);
    s.beginMove({
      union: frame(0, 300),
      baseFrames: new Map([['a', frame(0, 300)]]),
      snapTargets: [frame(0, 0, 100, 100)],
    });
    expect(s.session.guides()).toEqual([
      { axis: 'x', position: 0, from: 0, to: 340 },
    ]);
    s.pointerX.set(420);
    s.pointerY.set(-180);
    expect(s.session.guides()).toEqual([
      { axis: 'y', position: 0, from: 0, to: 340 },
    ]);
  });

  it.each([
    {
      name: 'area, not aspect, decides innermost',
      containers: [
        { key: 'outer', box: frame(0, 0, 400, 400) },
        { key: 'inner', box: frame(0, 0, 300, 20) },
      ],
      expected: 'inner',
    },
    {
      name: 'the smaller box wins whatever the order',
      containers: [
        { key: 'inner', box: frame(0, 0, 50, 50) },
        { key: 'outer', box: frame(0, 0, 400, 400) },
      ],
      expected: 'inner',
    },
    {
      name: 'identical boxes: the later registration wins',
      containers: [
        { key: 'parent', box: frame(0, 0, 100, 100) },
        { key: 'child', box: frame(0, 0, 100, 100) },
      ],
      expected: 'child',
    },
  ])('hover container: $name', (t) => {
    const s = setup(injector);
    s.beginMove({ containers: t.containers });
    s.pointerX.set(10);
    s.pointerY.set(10);
    expect(s.session.hoverContainer()).toBe(t.expected);
  });
});
