import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { panZoom, type PanZoomOptions } from './pan-zoom';

function pe(type: string, x: number, y: number, button = 0): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = button;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

function wheel(deltaY: number, x: number, y: number): Event {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  e['deltaY'] = deltaY;
  e['clientX'] = x;
  e['clientY'] = y;
  return e;
}

function setup(opts: PanZoomOptions = {}) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, x: 0, y: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
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
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const ref = TestBed.runInInjectionContext(() => panZoom());
    expect(ref.transform()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(ref.toCanvas({ x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});
