import { signal } from '@angular/core';

import {
  canvas,
  type CanvasCommitEvent,
  type CanvasOptions,
} from './controller';
import type { CanvasFrame } from './geometry';

type Widget = { id: string; frame: CanvasFrame };

const f = (x: number, y: number, width = 40, height = 40): CanvasFrame => ({
  x,
  y,
  width,
  height,
});

const OPTS: CanvasOptions<Widget, string> = {
  key: (w) => w.id,
  frame: (w) => w.frame,
  patch: (w, frame) => ({ ...w, frame }),
};

const SHIFT = { shift: true, ctrl: false, alt: false };
const CTRL = { shift: false, ctrl: true, alt: false };
const ALT = { shift: false, ctrl: false, alt: true };

/** a at (100,100), b at (200,100), c at (300,300); element rects mirror the frames, surface at 0,0. */
function setup(extra: Partial<CanvasOptions<Widget, string>> = {}) {
  const source = signal<readonly Widget[]>([
    { id: 'a', frame: f(100, 100) },
    { id: 'b', frame: f(200, 100) },
    { id: 'c', frame: f(300, 300, 60, 60) },
  ]);
  const ctrl = canvas<Widget, string>(source, { ...OPTS, ...extra });
  ctrl.setSurface({
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLElement);
  const els = new Map<string, HTMLElement>();
  for (const it of source()) {
    const el = {
      getBoundingClientRect: () => {
        const fr = source().find((i) => i.id === it.id)?.frame ?? it.frame;
        return { left: fr.x, top: fr.y, width: fr.width, height: fr.height };
      },
    } as unknown as HTMLElement;
    els.set(it.id, el);
    ctrl.register(it.id, el);
  }
  const frameOf = (id: string) => source().find((i) => i.id === id)?.frame;
  const dragA = (
    dx: number,
    dy: number,
    mods?: { shift: boolean; ctrl: boolean; alt: boolean },
  ) => {
    expect(
      ctrl.beginFromPress(
        { mode: 'move', itemEl: els.get('a') as HTMLElement },
        { x: 105, y: 105 },
        false,
      ),
    ).toBe(true);
    ctrl.move({ x: 105 + dx, y: 105 + dy }, mods);
  };
  const resizeA = (direction: 'se' | 'e', from: { x: number; y: number }) => {
    ctrl.selection.set(['a']);
    return ctrl.beginFromPress({ mode: 'resize', direction }, from, false);
  };
  return { source, ctrl, frameOf, dragA, resizeA };
}

describe('canvas options: snapping', () => {
  // a +57 move ends a's right edge 3px short of b's left edge (197 vs 200)
  it('snaps to a sibling edge by default and shows guides mid-drag', () => {
    const { ctrl, frameOf, dragA } = setup();
    dragA(57, 0);
    expect(ctrl.session.guides().length).toBeGreaterThan(0);
    ctrl.end();
    expect(frameOf('a')?.x).toBe(160);
  });

  it('snap: false turns snaplines off', () => {
    const { ctrl, frameOf, dragA } = setup({ snap: false });
    dragA(57, 0);
    expect(ctrl.session.guides()).toEqual([]);
    ctrl.end();
    expect(frameOf('a')?.x).toBe(157);
  });

  it('a custom threshold replaces the default 6', () => {
    const { ctrl, frameOf, dragA } = setup({ snap: { threshold: 2 } });
    dragA(57, 0);
    ctrl.end();
    expect(frameOf('a')?.x).toBe(157);
  });

  it('Ctrl bypasses the snaplines and the grid', () => {
    const snapped = setup();
    snapped.dragA(57, 0, CTRL);
    snapped.ctrl.end();
    expect(snapped.frameOf('a')?.x).toBe(157);

    const gridded = setup({ grid: { size: 50 } });
    gridded.dragA(13, 0, CTRL);
    gridded.ctrl.end();
    expect(gridded.frameOf('a')?.x).toBe(113);
  });

  it('snaps to the bounds edges only with toCanvas', () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
    const off = setup({ bounds });
    off.dragA(-97, 0);
    off.ctrl.end();
    expect(off.frameOf('a')?.x).toBe(3);

    const on = setup({ bounds, snap: { toCanvas: true } });
    on.dragA(-97, 0);
    on.ctrl.end();
    expect(on.frameOf('a')?.x).toBe(0);
  });

  it('a resized edge snaps to a sibling, never to its own start edges', () => {
    const { ctrl, frameOf, resizeA } = setup();
    resizeA('se', { x: 140, y: 140 });
    ctrl.move({ x: 197, y: 140 });
    expect(ctrl.session.guides().length).toBeGreaterThan(0);
    ctrl.end();
    expect(frameOf('a')?.width).toBe(100);

    const small = setup();
    small.resizeA('se', { x: 140, y: 140 });
    small.ctrl.move({ x: 144, y: 140 });
    small.ctrl.end();
    expect(small.frameOf('a')?.width).toBe(44);
  });
});

describe('canvas options: modifiers', () => {
  it('Shift locks a move to its dominant axis by default', () => {
    const { ctrl, frameOf, dragA } = setup();
    dragA(40, 10, SHIFT);
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 140, y: 100 });
  });

  it('Alt resizes from the center', () => {
    const { ctrl, frameOf, resizeA } = setup();
    resizeA('e', { x: 140, y: 120 });
    ctrl.move({ x: 150, y: 120 }, ALT);
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 90, width: 60 });
  });
});

describe('canvas options: resize and rotate', () => {
  it('resize: false refuses pointer and keyboard resizes', () => {
    const { ctrl, frameOf, resizeA } = setup({ resize: false });
    expect(resizeA('se', { x: 140, y: 140 })).toBe(false);
    expect(ctrl.nudgeResize(1, 1, false)).toBe(false);
    expect(frameOf('a')).toEqual(f(100, 100));
  });

  it('a pointer resize honours resize.min and resize.max', () => {
    const { ctrl, frameOf, resizeA } = setup({
      resize: {
        min: { width: 30, height: 30 },
        max: { width: 60, height: 60 },
      },
    });
    resizeA('se', { x: 140, y: 140 });
    ctrl.move({ x: 100, y: 100 });
    expect(ctrl.liveFrames()?.get('a')).toEqual(f(100, 100, 30, 30));
    ctrl.move({ x: 200, y: 200 });
    ctrl.end();
    expect(frameOf('a')).toEqual(f(100, 100, 60, 60));
  });

  it('rotate is off by default', () => {
    const { ctrl } = setup();
    ctrl.selection.set(['a']);
    expect(
      ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false),
    ).toBe(false);
    expect(ctrl.session.kind()).toBeNull();
  });

  it('rotate: true enables it', () => {
    const { ctrl, frameOf } = setup({ rotate: true });
    ctrl.selection.set(['a']);
    expect(
      ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false),
    ).toBe(true);
    ctrl.move({ x: 120, y: 150 });
    ctrl.end();
    expect(frameOf('a')?.rotation).toBe(90);
  });

  it('rotate.snap engages with Shift', () => {
    const { ctrl, frameOf } = setup({ rotate: { snap: 15 } });
    ctrl.selection.set(['a']);
    ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false);
    const rad = (50 * Math.PI) / 180; // a 50° sweep around the pivot (120,120)
    ctrl.move(
      { x: 120 + 30 * Math.cos(rad), y: 120 + 30 * Math.sin(rad) },
      SHIFT,
    );
    ctrl.end();
    expect(frameOf('a')?.rotation).toBe(45);
  });
});

describe('canvas options: resolved config', () => {
  it('activationThreshold defaults to 3 and passes an explicit value through', () => {
    const src = signal<readonly Widget[]>([]);
    expect(canvas(src, OPTS).activationThreshold).toBe(3);
    expect(
      canvas(src, { ...OPTS, activationThreshold: 7 }).activationThreshold,
    ).toBe(7);
  });

  it('autoScroll is off unless set; unset fields take edge 48 and speed 16', () => {
    const src = signal<readonly Widget[]>([]);
    expect(canvas(src, OPTS).autoScroll).toBeNull();
    expect(canvas(src, { ...OPTS, autoScroll: {} }).autoScroll).toEqual({
      edge: 48,
      speed: 16,
      edgeProportion: undefined,
      maxSpeedAt: undefined,
    });
    expect(
      canvas(src, {
        ...OPTS,
        autoScroll: {
          edge: 10,
          speed: 4,
          edgeProportion: 0.5,
          maxSpeedAt: 0.2,
        },
      }).autoScroll,
    ).toEqual({ edge: 10, speed: 4, edgeProportion: 0.5, maxSpeedAt: 0.2 });
  });
});

describe('canvas options: keyboard', () => {
  it('keyboard: false turns off nudging and keyboard resizing', () => {
    const commits: CanvasCommitEvent<Widget, string>[] = [];
    const { ctrl, frameOf } = setup({
      keyboard: false,
      onCommit: (e) => commits.push(e),
    });
    expect(ctrl.keyboard).toBeNull();
    ctrl.selection.set(['a']);
    expect(ctrl.nudge(1, 0, false)).toBe(false);
    expect(ctrl.nudgeResize(1, 1, false)).toBe(false);
    expect(frameOf('a')).toEqual(f(100, 100));
    expect(commits).toHaveLength(0);
  });

  it('keyboard.step and keyboard.largeStep set the nudge distances', () => {
    const { ctrl, frameOf } = setup({ keyboard: { step: 5, largeStep: 20 } });
    ctrl.selection.set(['a']);
    ctrl.nudge(1, 0, false);
    expect(frameOf('a')?.x).toBe(105);
    ctrl.nudge(1, 0, true);
    expect(frameOf('a')?.x).toBe(125);
  });
});

describe('canvas options: announceTransform', () => {
  type Ev = { item: Widget; frame: CanvasFrame; count: number };

  it('announces every keyboard nudge and resize through the installed sink', () => {
    const events: Ev[] = [];
    const messages: string[] = [];
    const { ctrl, frameOf } = setup({
      announceTransform: (e) => {
        events.push(e);
        return `moved ${e.count}`;
      },
    });
    ctrl.setAnnounce((m) => messages.push(m));
    ctrl.selection.set(['a', 'b']);
    expect(ctrl.nudge(1, 0, false)).toBe(true);
    expect(messages).toEqual(['moved 2']);
    expect(events[0].frame).toEqual(frameOf('b'));
    expect(events[0].item.id).toBe('b');

    ctrl.selection.set(['a']);
    expect(ctrl.nudgeResize(1, 0, false)).toBe(true);
    expect(messages).toEqual(['moved 2', 'moved 1']);
    expect(events[1]).toMatchObject({ count: 1, frame: frameOf('a') });
    expect(events[1].item.id).toBe('a');
  });

  it('without a builder nothing is announced, and nothing throws', () => {
    const messages: string[] = [];
    const { ctrl } = setup();
    ctrl.setAnnounce((m) => messages.push(m));
    ctrl.selection.set(['a']);
    expect(ctrl.nudge(1, 0, false)).toBe(true);
    expect(ctrl.nudgeResize(1, 0, false)).toBe(true);
    expect(messages).toEqual([]);
  });

  it('a builder with no sink installed does not throw', () => {
    const { ctrl } = setup({ announceTransform: () => 'x' });
    ctrl.selection.set(['a']);
    expect(() => ctrl.nudge(1, 0, false)).not.toThrow();
    expect(() => ctrl.nudgeResize(1, 0, false)).not.toThrow();
  });

  it('an empty selection nudges nothing and announces nothing', () => {
    const messages: string[] = [];
    const commits: CanvasCommitEvent<Widget, string>[] = [];
    const { ctrl } = setup({
      announceTransform: () => 'x',
      bounds: { x: 0, y: 0, width: 1000, height: 1000 },
      onCommit: (e) => commits.push(e),
    });
    ctrl.setAnnounce((m) => messages.push(m));
    expect(ctrl.nudge(1, 0, false)).toBe(false);
    expect(messages).toEqual([]);
    expect(commits).toHaveLength(0);
  });

  it('false opts out like no builder', () => {
    const messages: string[] = [];
    const { ctrl } = setup({ announceTransform: false });
    ctrl.setAnnounce((m) => messages.push(m));
    ctrl.selection.set(['a']);
    ctrl.nudge(1, 0, false);
    expect(messages).toEqual([]);
  });
});
