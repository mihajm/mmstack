import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { Box } from './geometry';
import { resizeHandle } from './resizable';

const BASE: Box = { x: 0, y: 0, width: 100, height: 100 };

function pe(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
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

  it('Shift holds the aspect ratio, Alt resizes from center', () => {
    const { el, box } = setup('se');
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    const shifted = pe('pointermove', 20, 5) as Event & Record<string, unknown>;
    shifted['shiftKey'] = true;
    el.dispatchEvent(shifted);
    TestBed.tick();
    expect(box()).toEqual({ x: 0, y: 0, width: 120, height: 120 });

    const alted = pe('pointermove', 10, 0) as Event & Record<string, unknown>;
    alted['altKey'] = true;
    el.dispatchEvent(alted);
    TestBed.tick();
    expect(box()).toEqual({ x: -10, y: 0, width: 120, height: 100 });
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
