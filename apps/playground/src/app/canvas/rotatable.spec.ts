import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { rotatable } from './rotatable';
import type { Point } from './geometry';

function pe(type: string, x: number, y: number, shiftKey = false): Event {
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = shiftKey;
  e['altKey'] = e['ctrlKey'] = e['metaKey'] = false;
  return e;
}

const CENTER: Point = { x: 100, y: 100 };

function setup(
  opts: Partial<Parameters<typeof rotatable>[1]> = {},
  startAngle = 0,
) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const angle = signal(startAngle);
  const ref = TestBed.runInInjectionContext(() =>
    rotatable(angle, { center: CENTER, ...opts }),
  );
  return { el, angle, ref };
}

describe('rotatable', () => {
  it('rotates by the pointer angle around the center', () => {
    const { el, angle, ref } = setup();
    el.dispatchEvent(pe('pointerdown', 200, 100)); // 0°
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 100, 200)); // 90°
    TestBed.tick();
    expect(ref.rotating()).toBe(true);
    expect(angle()).toBeCloseTo(90, 3);
  });

  it('adds to the starting angle', () => {
    const { el, angle } = setup({}, 30);
    el.dispatchEvent(pe('pointerdown', 200, 100));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 100, 200));
    TestBed.tick();
    expect(angle()).toBeCloseTo(120, 3);
  });

  it('snaps to increments while Shift is held', () => {
    const { el, angle } = setup({ snap: 15 });
    el.dispatchEvent(pe('pointerdown', 200, 100));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 105, 200, true)); // ~87.1° → snaps to 90°
    TestBed.tick();
    expect(angle()).toBe(90);
  });

  it('normalizes into [0, 360)', () => {
    const { el, angle } = setup({}, 0);
    el.dispatchEvent(pe('pointerdown', 200, 100)); // 0°
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 100, 0)); // -90° → 270°
    TestBed.tick();
    expect(angle()).toBeCloseTo(270, 3);
  });

  it('is inert on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    const angle = signal(0);
    const ref = TestBed.runInInjectionContext(() =>
      rotatable(angle, { center: CENTER }),
    );
    expect(ref.rotating()).toBe(false);
  });
});
