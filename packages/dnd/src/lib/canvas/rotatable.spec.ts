import {
  Component,
  ElementRef,
  PLATFORM_ID,
  signal,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { RotateHandle, rotatable } from './rotatable';
import type { Point } from './geometry';

function pe(type: string, x: number, y: number, shiftKey = false): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
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
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement('div')),
        },
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

describe('rotatable: gesture contract', () => {
  it('applies a move and release that land in the same frame', () => {
    const { el, angle } = setup();
    el.dispatchEvent(pe('pointerdown', 200, 100));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 200, 200));
    el.dispatchEvent(pe('pointerup', 100, 200));
    TestBed.tick();
    expect(angle()).toBeCloseTo(90, 3);
  });

  it('a press that began disabled is not reported as rotating', () => {
    const disabled = signal(true);
    const { el, angle, ref } = setup({ disabled });
    el.dispatchEvent(pe('pointerdown', 200, 100));
    TestBed.tick();
    disabled.set(false);
    el.dispatchEvent(pe('pointermove', 100, 200));
    TestBed.tick();
    expect(ref.rotating()).toBe(false);
    expect(angle()).toBe(0);
  });
});

describe('rotatable: options and lifecycle', () => {
  const fire = (el: HTMLElement, type: string, x: number, y: number) => {
    el.dispatchEvent(pe(type, x, y));
    TestBed.tick();
  };

  it('reports start, live and final angles once each gesture', () => {
    const start = vi.fn();
    const live = vi.fn();
    const end = vi.fn();
    const { el, angle, ref } = setup({
      onRotateStart: start,
      onRotate: live,
      onRotateEnd: end,
    });
    TestBed.tick();
    expect(ref.rotating()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    fire(el, 'pointermove', 0, 100);
    expect(angle()).toBeCloseTo(180, 3);
    fire(el, 'pointerup', 0, 100);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ angle: 0 });
    expect(live.mock.calls[0][0].angle).toBeCloseTo(90, 3);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][0].angle).toBeCloseTo(180, 3);
    expect(ref.rotating()).toBe(false);
    expect(angle()).toBeCloseTo(180, 3);
  });

  it('a second gesture starts from the current angle', () => {
    const { el, angle } = setup();
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    fire(el, 'pointerup', 100, 200);
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    expect(angle()).toBeCloseTo(180, 3);
  });

  it('a disabled press emits nothing, and the next press after enabling rotates', () => {
    const disabled = signal(true);
    const start = vi.fn();
    const end = vi.fn();
    const { el, angle } = setup({
      disabled,
      onRotateStart: start,
      onRotateEnd: end,
    });
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    fire(el, 'pointerup', 100, 200);
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(angle()).toBe(0);
    disabled.set(false);
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    expect(angle()).toBeCloseTo(90, 3);
  });

  it('honors activationThreshold, and snaps only with Shift', () => {
    const a = setup({ activationThreshold: 10 });
    fire(a.el, 'pointerdown', 200, 100);
    fire(a.el, 'pointermove', 200, 105);
    expect(a.ref.rotating()).toBe(false);
    expect(a.angle()).toBe(0);
    fire(a.el, 'pointermove', 200, 115);
    expect(a.ref.rotating()).toBe(true);

    const s = setup({ snap: 15 });
    fire(s.el, 'pointerdown', 200, 100);
    fire(s.el, 'pointermove', 105, 200);
    expect(s.angle()).toBeCloseTo(87.14, 1);
  });

  it('releasing without callbacks does not throw', () => {
    const { el, angle } = setup();
    fire(el, 'pointerdown', 200, 100);
    fire(el, 'pointermove', 100, 200);
    expect(() => fire(el, 'pointerup', 100, 200)).not.toThrow();
    expect(angle()).toBeCloseTo(90, 3);
  });
});

describe('RotateHandle directive', () => {
  @Component({
    selector: 'mm-rotate-host',
    imports: [RotateHandle],
    template: `<div
      class="h"
      [mmRotateHandle]="angle"
      [center]="center"
      [snap]="15"
      #r="mmRotateHandle"
    ></div>`,
  })
  class Host {
    readonly angle = signal(0);
    readonly center = CENTER;
    readonly dir = viewChild.required<RotateHandle>('r');
  }

  it('rotates the bound angle, unsnapped without Shift by default', () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    const el = fixture.nativeElement.querySelector('.h') as HTMLElement;
    const fire = (type: string, x: number, y: number) => {
      el.dispatchEvent(pe(type, x, y));
      TestBed.tick();
    };
    expect(host.dir().rotating()).toBe(false);
    fire('pointerdown', 200, 100);
    fire('pointermove', 105, 200);
    expect(host.dir().rotating()).toBe(true);
    expect(host.angle()).toBeCloseTo(87.14, 1);
    fire('pointerup', 105, 200);
    expect(host.dir().rotating()).toBe(false);
  });
});
