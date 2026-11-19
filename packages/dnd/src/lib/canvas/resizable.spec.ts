import {
  Component,
  ElementRef,
  PLATFORM_ID,
  signal,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { Box } from './geometry';
import { ResizeHandle, resizeHandle } from './resizable';

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

describe('resizeHandle: gesture contract', () => {
  function setup(
    direction: Parameters<typeof resizeHandle>[1] = 'se',
    opts: Parameters<typeof resizeHandle>[2] = {},
    base: Box = BASE,
  ) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const box = signal<Box>({ ...base });
    const ref = TestBed.runInInjectionContext(() =>
      resizeHandle(box, direction, opts),
    );
    const fire = (e: Event) => {
      el.dispatchEvent(e);
      TestBed.tick();
    };
    return { el, box, ref, fire };
  }

  it('applies a move and release that land in the same frame', () => {
    const { el, box } = setup('se');
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 30, 20));
    el.dispatchEvent(pe('pointerup', 40, 30));
    TestBed.tick();
    expect(box()).toEqual({ x: 0, y: 0, width: 140, height: 130 });
  });

  it('a press that began disabled is not reported as resizing', () => {
    const disabled = signal(true);
    const { el, box, ref, fire } = setup('se', { disabled });
    fire(pe('pointerdown', 0, 0));
    disabled.set(false);
    el.dispatchEvent(pe('pointermove', 30, 20));
    TestBed.tick();
    expect(ref.resizing()).toBe(false);
    expect(box()).toEqual(BASE);
  });
});

describe('resizeHandle: options and lifecycle', () => {
  function setup(
    direction: Parameters<typeof resizeHandle>[1] = 'se',
    opts: Parameters<typeof resizeHandle>[2] = {},
    base: Box = BASE,
  ) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const box = signal<Box>({ ...base });
    const ref = TestBed.runInInjectionContext(() =>
      resizeHandle(box, direction, opts),
    );
    const fire = (type: string, x: number, y: number, shift = false) => {
      const e = pe(type, x, y) as Event & Record<string, unknown>;
      e['shiftKey'] = shift;
      el.dispatchEvent(e);
      TestBed.tick();
    };
    return { el, box, ref, fire };
  }

  it('reports start, live and final boxes; idle and release states are clean', () => {
    const start = vi.fn();
    const live = vi.fn();
    const end = vi.fn();
    const { box, ref, fire } = setup('se', {
      onResizeStart: start,
      onResize: live,
      onResizeEnd: end,
    });
    TestBed.tick();
    expect(ref.resizing()).toBe(false);
    expect(ref.guides()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    fire('pointerdown', 0, 0);
    fire('pointermove', 30, 20);
    fire('pointerup', 30, 20);
    expect(start).toHaveBeenCalledWith({ box: BASE });
    expect(live).toHaveBeenLastCalledWith({
      box: { x: 0, y: 0, width: 130, height: 120 },
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith({
      box: { x: 0, y: 0, width: 130, height: 120 },
    });
    expect(ref.resizing()).toBe(false);
    expect(box()).toEqual({ x: 0, y: 0, width: 130, height: 120 });
  });

  it('a second gesture starts from the current box', () => {
    const { box, fire } = setup('e');
    fire('pointerdown', 0, 0);
    fire('pointermove', 30, 0);
    fire('pointerup', 30, 0);
    fire('pointerdown', 0, 0);
    fire('pointermove', 10, 0);
    expect(box().width).toBe(140);
  });

  it('releasing without callbacks does not throw', () => {
    const { fire, box } = setup('e');
    fire('pointerdown', 0, 0);
    fire('pointermove', 30, 0);
    expect(() => fire('pointerup', 30, 0)).not.toThrow();
    expect(box().width).toBe(130);
  });

  it('a disabled press emits nothing, and the next press after enabling resizes', () => {
    const disabled = signal(true);
    const start = vi.fn();
    const end = vi.fn();
    const { box, fire } = setup('e', {
      disabled,
      onResizeStart: start,
      onResizeEnd: end,
    });
    fire('pointerdown', 0, 0);
    fire('pointermove', 30, 0);
    fire('pointerup', 30, 0);
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(box()).toEqual(BASE);
    disabled.set(false);
    fire('pointerdown', 0, 0);
    fire('pointermove', 30, 0);
    expect(box().width).toBe(130);
  });

  it('honors activationThreshold, grid, bounds and snapThreshold', () => {
    const a = setup('e', { activationThreshold: 10 });
    a.fire('pointerdown', 0, 0);
    a.fire('pointermove', 5, 0);
    expect(a.ref.resizing()).toBe(false);
    expect(a.box()).toEqual(BASE);

    const g = setup('e', { grid: { size: 10 } });
    g.fire('pointerdown', 0, 0);
    g.fire('pointermove', 13, 0);
    expect(g.box().width).toBe(110);

    const b = setup('e', { bounds: { x: 0, y: 0, width: 120, height: 200 } });
    b.fire('pointerdown', 0, 0);
    b.fire('pointermove', 50, 0);
    expect(b.box().width).toBe(120);

    const s = setup('e', {
      snapThreshold: 2,
      snapTargets: [{ x: 104, y: 300, width: 20, height: 20 }],
    });
    s.fire('pointerdown', 0, 0);
    s.fire('pointermove', 0, 3);
    expect(s.ref.resizing()).toBe(true);
    expect(s.box().width).toBe(100);
    expect(s.ref.guides()).toEqual([]);
  });

  it('Shift on a zero-height box keeps finite numbers (no aspect lock)', () => {
    const { box, fire } = setup('e', {}, { x: 0, y: 0, width: 100, height: 0 });
    fire('pointerdown', 0, 0);
    fire('pointermove', 20, 0, true);
    expect(box()).toEqual({ x: 0, y: 0, width: 120, height: 0 });
  });
});

describe('ResizeHandle directive', () => {
  @Component({
    selector: 'mm-resize-host',
    imports: [ResizeHandle],
    template: `<div
      class="h"
      [mmResizeHandle]="box"
      direction="e"
      [min]="{ width: 40 }"
      [max]="{ width: 150 }"
      [bounds]="bounds"
      [snapTargets]="targets"
      #r="mmResizeHandle"
    ></div>`,
  })
  class Host {
    readonly box = signal<Box>({ ...BASE });
    readonly bounds: Box = { x: 0, y: 0, width: 104, height: 300 };
    readonly targets: Box[] = [];
    readonly dir = viewChild.required<ResizeHandle>('r');
  }

  function render() {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.h') as HTMLElement;
    const fire = (type: string, x: number, y: number) => {
      el.dispatchEvent(pe(type, x, y));
      TestBed.tick();
    };
    return { host: fixture.componentInstance, fire };
  }

  it('resizes the bound box with min, max and bounds, no canvas snap by default', () => {
    const { host, fire } = render();
    expect(host.dir().resizing()).toBe(false);
    expect(host.dir().guides()).toEqual([]);
    fire('pointerdown', 0, 0);
    fire('pointermove', 2, 0);
    expect(host.dir().resizing()).toBe(true);
    expect(host.box().width).toBe(102);
    fire('pointermove', -90, 0);
    expect(host.box().width).toBe(40);
    fire('pointermove', 90, 0);
    expect(host.box().width).toBe(104);
    fire('pointerup', 90, 0);
    expect(host.dir().resizing()).toBe(false);
  });
});
