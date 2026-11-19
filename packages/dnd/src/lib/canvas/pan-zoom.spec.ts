import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { panZoom, type PanZoomOptions } from './pan-zoom';

function pe(type: string, x: number, y: number, button = 0): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = button;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

function wheel(
  deltaY: number,
  x: number,
  y: number,
  opts: { deltaMode?: number; ctrlKey?: boolean } = {},
): Event {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  e['deltaY'] = deltaY;
  e['clientX'] = x;
  e['clientY'] = y;
  e['deltaMode'] = opts.deltaMode ?? 0;
  e['ctrlKey'] = opts.ctrlKey ?? false;
  return e;
}

function setup(opts: PanZoomOptions = {}) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const ref = TestBed.runInInjectionContext(() =>
    panZoom(undefined, { panButtons: [0], ...opts }),
  );
  TestBed.tick(); // flush the pan + wheel-attach effects
  return { el, ref };
}

describe('panZoom', () => {
  it('pans with the configured button', () => {
    const { el, ref } = setup();
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 20, 10));
    TestBed.tick();
    expect(ref.panning()).toBe(true);
    expect(ref.transform()).toEqual({ x: 20, y: 10, scale: 1 });

    el.dispatchEvent(pe('pointerup', 20, 10));
    TestBed.tick();
    expect(ref.panning()).toBe(false);
  });

  it('zooms on wheel around the cursor', () => {
    const { el, ref } = setup({ zoomSpeed: 0.0015 });
    el.dispatchEvent(wheel(-100, 0, 0));
    const t = ref.transform();
    expect(t.scale).toBeCloseTo(Math.exp(0.15), 5);
    // cursor at origin → no translation introduced
    expect(t.x).toBeCloseTo(0, 5);
    expect(t.y).toBeCloseTo(0, 5);
  });

  it('zooms a trackpad pinch — ctrl-wheel — tenfold', () => {
    const { el, ref } = setup({ zoomSpeed: 0.0015 });
    el.dispatchEvent(wheel(-100, 0, 0, { ctrlKey: true }));
    expect(ref.transform().scale).toBeCloseTo(Math.exp(1.5), 5);
  });

  it('normalizes line-mode wheels to pixel magnitude', () => {
    const { el, ref } = setup({ zoomSpeed: 0.0015 });
    el.dispatchEvent(wheel(-4, 0, 0, { deltaMode: 1 }));
    expect(ref.transform().scale).toBeCloseTo(Math.exp(0.15), 5);
  });

  it('cancels Safari gesture events over the viewport', () => {
    const { el } = setup();
    const e = new Event('gesturestart', { cancelable: true });
    el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('keeps the canvas point under the cursor fixed when zooming', () => {
    const { el, ref } = setup();
    const before = ref.toCanvas({ x: 100, y: 0 });
    el.dispatchEvent(wheel(-200, 100, 0));
    const after = ref.toCanvas({ x: 100, y: 0 });
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it('clamps scale to min/max', () => {
    const { el, ref } = setup({ minScale: 0.5, maxScale: 2 });
    el.dispatchEvent(wheel(-100000, 0, 0));
    expect(ref.transform().scale).toBe(2);
    el.dispatchEvent(wheel(100000, 0, 0));
    expect(ref.transform().scale).toBe(0.5);
  });

  it('round-trips toViewport ∘ toCanvas after a pan', () => {
    const { el, ref } = setup();
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 15, 25));
    TestBed.tick();
    const p = { x: 30, y: 40 };
    const back = ref.toCanvas(ref.toViewport(p));
    expect(back.x).toBeCloseTo(p.x, 5);
    expect(back.y).toBeCloseTo(p.y, 5);
  });

  it('reset() returns to identity', () => {
    const { el, ref } = setup();
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 15, 25));
    TestBed.tick();
    expect(ref.transform()).not.toEqual({ x: 0, y: 0, scale: 1 });
    ref.reset();
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('does nothing while disabled', () => {
    const disabled = signal(true);
    const { el, ref } = setup({ disabled });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 20, 10));
    TestBed.tick();
    el.dispatchEvent(wheel(-100, 0, 0));
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('is inert on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement('div')),
        },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const ref = TestBed.runInInjectionContext(() => panZoom());
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(ref.toCanvas({ x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe('panZoom: gesture contract', () => {
  it('applies a move and release that land in the same frame', () => {
    const { el, ref } = setup();
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 10, 0));
    el.dispatchEvent(pe('pointerup', 20, 10));
    TestBed.tick();
    expect(ref.transform()).toEqual({ x: 20, y: 10, scale: 1 });
  });

  it('a press that began disabled is not reported as panning', () => {
    const disabled = signal(true);
    const { el, ref } = setup({ disabled });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    disabled.set(false);
    el.dispatchEvent(pe('pointermove', 20, 10));
    TestBed.tick();
    expect(ref.panning()).toBe(false);
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('a pan released while disabled does not leak its base into the next pan', () => {
    const disabled = signal(false);
    const { el, ref } = setup({ disabled });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 20, 10));
    TestBed.tick();
    disabled.set(true);
    TestBed.tick();
    el.dispatchEvent(pe('pointerup', 20, 10));
    TestBed.tick();
    disabled.set(false);
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 10, 0));
    TestBed.tick();
    expect(ref.transform()).toEqual({ x: 30, y: 10, scale: 1 });
  });
});

function rectAt(left: number, top: number): DOMRect {
  return {
    left,
    top,
    x: left,
    y: top,
    right: left + 400,
    bottom: top + 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('panZoom: options and geometry', () => {
  function bare(opts: PanZoomOptions = {}, at = rectAt(0, 0)) {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => at;
    TestBed.resetTestingModule();
    const ref = TestBed.runInInjectionContext(() => panZoom(el, opts));
    TestBed.tick();
    return { el, ref };
  }
  const press = (el: HTMLElement, to: { x: number; y: number }, b = 0) => {
    el.dispatchEvent(pe('pointerdown', 0, 0, b));
    el.dispatchEvent(pe('pointermove', to.x, to.y, b));
    TestBed.tick();
  };
  const release = (el: HTMLElement, at: { x: number; y: number }, b = 0) => {
    el.dispatchEvent(pe('pointerup', at.x, at.y, b));
    TestBed.tick();
  };

  it('pans with the middle button by default, not the primary', () => {
    const { el, ref } = bare();
    press(el, { x: 20, y: 10 }, 0);
    release(el, { x: 20, y: 10 }, 0);
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
    press(el, { x: 20, y: 10 }, 1);
    expect(ref.transform()).toEqual({ x: 20, y: 10, scale: 1 });
  });

  it('zooms at the documented default speed and prevents the page scroll', () => {
    const { el, ref } = bare();
    const e = wheel(-100, 0, 0);
    el.dispatchEvent(e);
    expect(ref.transform().scale).toBeCloseTo(
      Math.exp(100 * Math.LN2 * 0.002),
      6,
    );
    expect(e.defaultPrevented).toBe(true);
  });

  it('wheelZoom: false leaves wheel events alone', () => {
    const { el, ref } = bare({ wheelZoom: false });
    const e = wheel(-100, 0, 0);
    el.dispatchEvent(e);
    expect(ref.transform().scale).toBe(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('panning is false while disabled', () => {
    const disabled = signal(false);
    const { el, ref } = bare({ panButtons: [0], disabled });
    press(el, { x: 20, y: 10 });
    expect(ref.panning()).toBe(true);
    disabled.set(true);
    expect(ref.panning()).toBe(false);
  });

  it('disabling mid-pan freezes the transform', () => {
    const disabled = signal(false);
    const { el, ref } = bare({ panButtons: [0], disabled });
    press(el, { x: 20, y: 10 });
    disabled.set(true);
    el.dispatchEvent(pe('pointermove', 40, 20));
    TestBed.tick();
    expect(ref.transform()).toEqual({ x: 20, y: 10, scale: 1 });
  });

  it('follows the latest delta within a gesture and accumulates across gestures', () => {
    const { el, ref } = bare({ panButtons: [0] });
    press(el, { x: 20, y: 0 });
    el.dispatchEvent(pe('pointermove', 30, 5));
    TestBed.tick();
    expect(ref.transform()).toEqual({ x: 30, y: 5, scale: 1 });
    release(el, { x: 30, y: 5 });
    press(el, { x: 10, y: 0 });
    expect(ref.transform()).toEqual({ x: 40, y: 5, scale: 1 });
  });

  it('a sub-threshold press is not a pan', () => {
    const { el, ref } = bare({ panButtons: [0] });
    press(el, { x: 2, y: 0 });
    expect(ref.panning()).toBe(false);
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('a disabled press released, then enabled, lets the next press pan', () => {
    const disabled = signal(true);
    const { el, ref } = bare({ panButtons: [0], disabled });
    press(el, { x: 20, y: 0 });
    release(el, { x: 20, y: 0 });
    disabled.set(false);
    press(el, { x: 20, y: 0 });
    expect(ref.transform()).toEqual({ x: 20, y: 0, scale: 1 });
  });

  it('keeps the cursor point fixed across zooms at an offset viewport', () => {
    const { el, ref } = bare({}, rectAt(50, 30));
    const cursor = { x: 150, y: 80 };
    const before = ref.toCanvas(cursor);
    el.dispatchEvent(wheel(-200, cursor.x, cursor.y));
    el.dispatchEvent(wheel(-150, cursor.x, cursor.y));
    const after = ref.toCanvas(cursor);
    expect(ref.transform().scale).toBeGreaterThan(1);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(before).toEqual({ x: 100, y: 50 });
  });

  it('projects absolute points through origin, pan and scale', () => {
    const { el, ref } = bare({ panButtons: [0] }, rectAt(50, 30));
    el.dispatchEvent(wheel(-500, 50, 30));
    const s = ref.transform().scale;
    press(el, { x: 10, y: 20 });
    expect(ref.transform()).toEqual({ x: 10, y: 20, scale: s });
    expect(ref.toCanvas({ x: 50 + 10 + 2 * s, y: 30 + 20 + 3 * s })).toEqual({
      x: expect.closeTo(2, 6),
      y: expect.closeTo(3, 6),
    });
    expect(ref.toViewport({ x: 2, y: 3 })).toEqual({
      x: expect.closeTo(60 + 2 * s, 6),
      y: expect.closeTo(50 + 3 * s, 6),
    });
  });

  it('waits for an unresolved viewport, and moves listeners when it changes', () => {
    const vp = signal<HTMLElement | undefined>(undefined);
    TestBed.resetTestingModule();
    const ref = TestBed.runInInjectionContext(() => panZoom(vp));
    expect(() => TestBed.tick()).not.toThrow();
    const a = document.createElement('div');
    const b = document.createElement('div');
    a.getBoundingClientRect = b.getBoundingClientRect = () => rectAt(0, 0);
    vp.set(a);
    TestBed.tick();
    a.dispatchEvent(wheel(-100, 0, 0));
    const s = ref.transform().scale;
    expect(s).toBeGreaterThan(1);
    vp.set(b);
    TestBed.tick();
    a.dispatchEvent(wheel(-100, 0, 0));
    expect(ref.transform().scale).toBe(s);
    const g = new Event('gesturestart', { cancelable: true });
    a.dispatchEvent(g);
    expect(g.defaultPrevented).toBe(false);
    b.dispatchEvent(wheel(-100, 0, 0));
    expect(ref.transform().scale).toBeGreaterThan(s);
  });

  it('is inert on the server: no wheel zoom, no panning, identity projection', () => {
    const el = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const ref = TestBed.runInInjectionContext(() => panZoom(el));
    TestBed.tick();
    el.dispatchEvent(wheel(-100, 0, 0));
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(ref.panning()).toBe(false);
    expect(ref.toViewport({ x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});
