import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { applyResize, resizeHandle, snapResizeBox } from './resizable';
import type { Box } from './geometry';

const BASE: Box = { x: 0, y: 0, width: 100, height: 100 };

describe('applyResize (pure)', () => {
  it('resizes from each cardinal edge', () => {
    expect(applyResize(BASE, 'e', { x: 20, y: 0 })).toEqual({ x: 0, y: 0, width: 120, height: 100 });
    expect(applyResize(BASE, 'w', { x: 20, y: 0 })).toEqual({ x: 20, y: 0, width: 80, height: 100 });
    expect(applyResize(BASE, 's', { x: 0, y: 30 })).toEqual({ x: 0, y: 0, width: 100, height: 130 });
    expect(applyResize(BASE, 'n', { x: 0, y: 30 })).toEqual({ x: 0, y: 30, width: 100, height: 70 });
  });

  it('resizes from corners', () => {
    expect(applyResize(BASE, 'se', { x: 10, y: 10 })).toEqual({ x: 0, y: 0, width: 110, height: 110 });
    expect(applyResize(BASE, 'nw', { x: 10, y: 10 })).toEqual({ x: 10, y: 10, width: 90, height: 90 });
  });

  it('enforces min size, anchoring the stationary edge', () => {
    expect(applyResize(BASE, 'e', { x: -200, y: 0 }, { min: { width: 20 } })).toEqual({
      x: 0, y: 0, width: 20, height: 100,
    });
    // dragging the west edge past min keeps the east edge fixed at x=100
    expect(applyResize(BASE, 'w', { x: 200, y: 0 }, { min: { width: 20 } })).toEqual({
      x: 80, y: 0, width: 20, height: 100,
    });
  });

  it('enforces max size', () => {
    expect(applyResize(BASE, 'e', { x: 1000, y: 0 }, { max: { width: 200 } })).toEqual({
      x: 0, y: 0, width: 200, height: 100,
    });
  });

  it('snaps resized edges to a grid', () => {
    expect(applyResize(BASE, 'se', { x: 12, y: 8 }, { grid: { size: 10 } })).toEqual({
      x: 0, y: 0, width: 110, height: 110,
    });
  });

  it('clamps within bounds', () => {
    expect(
      applyResize(BASE, 'e', { x: 1000, y: 0 }, { bounds: { x: 0, y: 0, width: 150, height: 150 } }),
    ).toEqual({ x: 0, y: 0, width: 150, height: 100 });
  });
});

describe('snapResizeBox (pure)', () => {
  it('snaps the resized east edge to a sibling edge and emits a guide', () => {
    const r = snapResizeBox(
      { x: 0, y: 0, width: 98, height: 50 },
      'se',
      [{ x: 100, y: 0, width: 20, height: 20 }],
      6,
    );
    expect(r.box.width).toBe(100); // right 98 → target left 100
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true);
  });

  it('leaves the stationary edges put', () => {
    const r = snapResizeBox(
      { x: 10, y: 10, width: 88, height: 40 },
      'se',
      [{ x: 100, y: 0, width: 10, height: 10 }],
      6,
    );
    expect(r.box.x).toBe(10);
    expect(r.box.y).toBe(10);
  });

  it('returns the box unchanged with no targets', () => {
    const b = { x: 0, y: 0, width: 50, height: 50 };
    expect(snapResizeBox(b, 'se', [], 6).box).toEqual(b);
    expect(snapResizeBox(b, 'se', [], 6).guides).toEqual([]);
  });
});

function pe(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

describe('resizeHandle', () => {
  function setup(direction: Parameters<typeof resizeHandle>[1], opts = {}) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const box = signal<Box>({ ...BASE });
    const ref = TestBed.runInInjectionContext(() =>
      resizeHandle(box, direction, { activationThreshold: 2, ...opts }),
    );
    return { el, box, ref };
  }

  it('grows the box when dragging a corner handle', () => {
    const { el, box, ref } = setup('se');
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 30, 20));
    TestBed.tick();
    expect(ref.resizing()).toBe(true);
    expect(box()).toEqual({ x: 0, y: 0, width: 130, height: 120 });
  });

  it('snaps a resized edge to a sibling and exposes guides', () => {
    const { el, box, ref } = setup('se', {
      snapTargets: () => [{ x: 104, y: 0, width: 20, height: 20 }],
      snapThreshold: 6,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 6, 0)); // right 100 → 106 → snaps to 104
    TestBed.tick();
    expect(box().width).toBe(104);
    expect(ref.guides().some((g) => g.axis === 'x')).toBe(true);
  });

  it('respects min size during a live resize', () => {
    const { el, box } = setup('e', { min: { width: 40 } });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', -90, 0));
    TestBed.tick();
    expect(box().width).toBe(40);
  });

  it('returns an inert ref on the server', () => {
    const el = document.createElement('div');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(el) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const box = signal<Box>({ ...BASE });
    const ref = TestBed.runInInjectionContext(() => resizeHandle(box, 'se'));
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 30, 30));
    TestBed.tick();
    expect(box()).toEqual(BASE);
    expect(ref.resizing()).toBe(false);
  });
});
