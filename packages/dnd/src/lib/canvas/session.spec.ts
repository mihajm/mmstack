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

const frame = (
  x: number,
  y: number,
  width = 40,
  height = 40,
): CanvasFrame => ({ x, y, width, height });

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
  const beginMove = (opts: Partial<CanvasGesture<string>> = {}) => {
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
        containers: [],
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
        containers: [],
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
        containers: [],
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
