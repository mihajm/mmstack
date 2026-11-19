import {
  Component,
  computed,
  ElementRef,
  PLATFORM_ID,
  signal,
  viewChild,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Movable, movable, type MovableOptions } from './movable';
import type { Point } from './geometry';

function pe(
  type: string,
  x: number,
  y: number,
  mods: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): Event {
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  e['pointerId'] = 1;
  e['clientX'] = x;
  e['clientY'] = y;
  e['pageX'] = x;
  e['pageY'] = y;
  e['button'] = 0;
  e['shiftKey'] = !!mods.shiftKey;
  e['altKey'] = false;
  e['ctrlKey'] = !!mods.ctrlKey;
  e['metaKey'] = false;
  return e;
}

function setup(opts: MovableOptions = {}, start: Point = { x: 0, y: 0 }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const position = signal<Point>(start);
  const ref = TestBed.runInInjectionContext(() => movable(position, opts));
  return { el, position, ref };
}

function tick() {
  TestBed.tick();
}

describe('movable', () => {
  it('writes position from the gesture delta once past the threshold', () => {
    const { el, position, ref } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    expect(ref.moving()).toBe(false);
    expect(position()).toEqual({ x: 0, y: 0 });

    el.dispatchEvent(pe('pointermove', 25, 10));
    tick();
    expect(ref.moving()).toBe(true);
    expect(position()).toEqual({ x: 25, y: 10 });
  });

  it('adds the delta to the captured base position', () => {
    const { el, position } = setup(
      { activationThreshold: 3 },
      { x: 100, y: 50 },
    );
    el.dispatchEvent(pe('pointerdown', 10, 10));
    tick();
    el.dispatchEvent(pe('pointermove', 30, 10));
    tick();
    expect(position()).toEqual({ x: 120, y: 50 });
  });

  it('snaps to the grid (and Ctrl bypasses it)', () => {
    const { el, position } = setup({
      grid: { size: 10 },
      activationThreshold: 3,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 12, 8));
    tick();
    expect(position()).toEqual({ x: 10, y: 10 });

    el.dispatchEvent(pe('pointermove', 12, 8, { ctrlKey: true }));
    tick();
    expect(position()).toEqual({ x: 12, y: 8 });
  });

  it('clamps within bounds', () => {
    const { el, position } = setup({
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      activationThreshold: 3,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 100, 100));
    tick();
    expect(position()).toEqual({ x: 50, y: 50 });
  });

  it('does not move when disabled', () => {
    const disabled = signal(true);
    const { el, position, ref } = setup({ disabled, activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 50, 0));
    tick();
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(ref.moving()).toBe(false);
  });

  it('fires move lifecycle callbacks', () => {
    const events: string[] = [];
    const { el } = setup({
      activationThreshold: 3,
      onMoveStart: () => events.push('start'),
      onMove: () => events.push('move'),
      onMoveEnd: () => events.push('end'),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    el.dispatchEvent(pe('pointerup', 20, 0));
    tick();
    expect(events).toEqual(['start', 'move', 'end']);
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
    const position = signal<Point>({ x: 0, y: 0 });
    const ref = TestBed.runInInjectionContext(() => movable(position));
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 50, 0));
    tick();
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(ref.moving()).toBe(false);
  });
});

describe('movable — Figma-grade behaviours', () => {
  it('locks to the dominant axis while Shift is held', () => {
    const { el, position } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 30, 8, { shiftKey: true }));
    tick();
    expect(position()).toEqual({ x: 30, y: 0 }); // y dominated out
  });

  it('moves a group by the same delta', () => {
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({
      group: () => [other],
      activationThreshold: 3,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 5));
    tick();
    expect(position()).toEqual({ x: 20, y: 5 });
    expect(other()).toEqual({ x: 120, y: 105 });
  });

  it('group move with snapTargets reading the members does not loop', () => {
    // Regression: the move effect must read options untracked, else it depends
    // on the very `pos` signals group-move writes → infinite loop / freeze.
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({
      activationThreshold: 3,
      size: () => ({ width: 20, height: 20 }),
      group: () => [other],
      snapTargets: () => [
        { x: other().x, y: other().y, width: 20, height: 20 },
      ],
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 40, 0));
    tick();
    expect(position()).toEqual({ x: 40, y: 0 });
    expect(other()).toEqual({ x: 140, y: 100 });
  });

  it('snaps to a sibling edge and exposes alignment guides', () => {
    const { el, position, ref } = setup({
      activationThreshold: 3,
      size: () => ({ width: 20, height: 20 }),
      snapTargets: () => [{ x: 10, y: 0, width: 20, height: 20 }],
      snapThreshold: 6,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 8, 200));
    tick();
    expect(position().x).toBe(10); // left edge snapped to target left
    expect(ref.guides().some((g) => g.axis === 'x')).toBe(true);
  });

  it('nudges with arrow keys (Ctrl = large step)', () => {
    const { el, position } = setup({ keyboard: true, grid: { size: 10 } });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(position()).toEqual({ x: 10, y: 0 });
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true }),
    );
    expect(position()).toEqual({ x: 10, y: 100 }); // large = step * 10
  });

  it('captures the gesture base from `from` (for reflow-style rendering)', () => {
    // position starts at 0,0 but the rendered cell is elsewhere → `from` seeds it
    const { el, position } = setup({
      activationThreshold: 3,
      from: () => ({ x: 200, y: 50 }),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    expect(position()).toEqual({ x: 220, y: 50 }); // from-base + delta, not 0,0 + delta
  });

  it('reflow usage (from + onMove writing external state read back by `from`) is loop-free', () => {
    // Mirrors the grid example: position renders from a derived cell, onMove
    // writes shared layout state that the derived cell depends on. If this
    // looped, the test would hang.
    const external = signal(5);
    const derivedCell = computed<Point>(() => ({ x: external() * 10, y: 0 }));
    const { el } = setup({
      activationThreshold: 3,
      from: () => derivedCell(),
      onMove: () => external.update((v) => v + 1),
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 40, 0));
    tick();
    expect(external()).toBeGreaterThan(5); // reached here ⇒ no infinite loop
  });

  it('callbacks run untracked: onMove that reads and writes app state does not loop', () => {
    const items = signal([{ x: 0 }]);
    let moves = 0;
    let starts = 0;
    let ends = 0;
    const { el, position } = setup({
      activationThreshold: 3,
      onMoveStart: () => {
        starts++;
        items();
      },
      onMove: (e) => {
        moves++;
        items.set(items().map(() => ({ x: e.position.x })));
      },
      onMoveEnd: () => {
        ends++;
        items();
      },
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 20, 0));
    tick();
    el.dispatchEvent(pe('pointermove', 30, 0));
    tick();
    expect(moves).toBe(2);
    expect(items()).toEqual([{ x: 30 }]);
    items.set([{ x: -1 }]);
    tick();
    expect(moves).toBe(2);
    expect(position()).toEqual({ x: 30, y: 0 });
    el.dispatchEvent(pe('pointerup', 30, 0));
    tick();
    items.set([{ x: -2 }]);
    tick();
    expect([starts, moves, ends]).toEqual([1, 2, 1]);
  });

  it('keyboard nudge moves the whole group by the same delta', () => {
    const other = signal<Point>({ x: 100, y: 100 });
    const { el, position } = setup({
      keyboard: { step: 10 },
      group: () => [other],
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(position()).toEqual({ x: 10, y: 0 });
    expect(other()).toEqual({ x: 110, y: 100 });
  });

  it('keyboard nudge respects bounds', () => {
    const { el, position } = setup({
      keyboard: { step: 10 },
      bounds: { x: 0, y: 0, width: 30, height: 30 },
      size: () => ({ width: 10, height: 10 }),
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(position()).toEqual({ x: 0, y: 0 }); // clamped at left edge
  });
});

function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

function drag(el: HTMLElement, to: Point, from: Point = { x: 0, y: 0 }) {
  el.dispatchEvent(pe('pointerdown', from.x, from.y));
  tick();
  el.dispatchEvent(pe('pointermove', to.x, to.y));
  tick();
}

describe('movable: contract', () => {
  it('starts with no guides and clears them on release', () => {
    const { el, ref } = setup({
      size: { width: 20, height: 20 },
      snapTargets: [{ x: 10, y: 0, width: 20, height: 20 }],
    });
    expect(ref.guides()).toEqual([]);
    drag(el, { x: 8, y: 200 });
    expect(ref.guides().length).toBeGreaterThan(0);
    el.dispatchEvent(pe('pointerup', 8, 200));
    tick();
    expect(ref.guides()).toEqual([]);
  });

  it('honors an explicit snapThreshold', () => {
    const { el, position, ref } = setup({
      size: { width: 20, height: 20 },
      snapTargets: [{ x: 10, y: 0, width: 20, height: 20 }],
      snapThreshold: 1,
    });
    drag(el, { x: 8, y: 200 });
    expect(position().x).toBe(8);
    expect(ref.guides()).toEqual([]);
  });

  it('snapTargets without a size never snap', () => {
    const { el, position, ref } = setup({
      snapTargets: [{ x: 10, y: 0, width: 20, height: 20 }],
    });
    drag(el, { x: 8, y: 200 });
    expect(position().x).toBe(8);
    expect(ref.guides()).toEqual([]);
  });

  it('honors an explicit activationThreshold', () => {
    const { el, position, ref } = setup({ activationThreshold: 10 });
    drag(el, { x: 5, y: 0 });
    expect(ref.moving()).toBe(false);
    expect(position()).toEqual({ x: 0, y: 0 });
    el.dispatchEvent(pe('pointermove', 15, 0));
    tick();
    expect(ref.moving()).toBe(true);
    expect(position()).toEqual({ x: 15, y: 0 });
  });

  it('a handle scopes where a drag can start', () => {
    const el = document.createElement('div');
    const handle = document.createElement('span');
    el.appendChild(handle);
    document.body.appendChild(el);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
    });
    const position = signal<Point>({ x: 0, y: 0 });
    TestBed.runInInjectionContext(() => movable(position, { handle }));
    tick();
    drag(el, { x: 20, y: 0 });
    expect(position()).toEqual({ x: 0, y: 0 });
    el.dispatchEvent(pe('pointerup', 20, 0));
    tick();
    drag(handle, { x: 20, y: 0 });
    expect(position()).toEqual({ x: 20, y: 0 });
  });

  it('reports positions and deltas to the callbacks', () => {
    const start = vi.fn();
    const move = vi.fn();
    const end = vi.fn();
    const { el } = setup(
      { onMoveStart: start, onMove: move, onMoveEnd: end },
      { x: 5, y: 5 },
    );
    tick();
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    drag(el, { x: 20, y: 0 });
    el.dispatchEvent(pe('pointerup', 20, 0));
    tick();
    expect(start).toHaveBeenCalledWith({ position: { x: 5, y: 5 } });
    expect(move).toHaveBeenLastCalledWith({
      position: { x: 25, y: 5 },
      delta: { x: 20, y: 0 },
    });
    expect(end).toHaveBeenCalledWith({ position: { x: 25, y: 5 } });
  });

  it('a press that began disabled stays inert, and the next press works', () => {
    const disabled = signal(true);
    const start = vi.fn();
    const end = vi.fn();
    const { el, position, ref } = setup({
      disabled,
      onMoveStart: start,
      onMoveEnd: end,
    });
    el.dispatchEvent(pe('pointerdown', 0, 0));
    tick();
    disabled.set(false);
    tick();
    el.dispatchEvent(pe('pointermove', 30, 0));
    tick();
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(ref.moving()).toBe(false);
    el.dispatchEvent(pe('pointerup', 30, 0));
    tick();
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    drag(el, { x: 30, y: 0 });
    expect(position()).toEqual({ x: 30, y: 0 });
    expect(ref.moving()).toBe(true);
  });

  it('moves a group from a non-origin start, clamping members to bounds', () => {
    const a = signal<Point>({ x: 100, y: 100 });
    const b = signal<Point>({ x: 140, y: 0 });
    const { el, position } = setup(
      { group: () => [a, b], bounds: { x: 0, y: 0, width: 150, height: 150 } },
      { x: 50, y: 30 },
    );
    drag(el, { x: 20, y: 5 });
    expect(position()).toEqual({ x: 70, y: 35 });
    expect(a()).toEqual({ x: 120, y: 105 });
    expect(b()).toEqual({ x: 150, y: 5 });
  });
});

describe('movable: scroll container', () => {
  let frames: FrameRequestCallback[] = [];
  const flush = () => {
    const batch = frames;
    frames = [];
    for (const f of batch) f(0);
  };
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  function scrollBox(left = 0, top = 0): HTMLElement {
    const sc = document.createElement('div');
    let l = left;
    let t = top;
    Object.defineProperty(sc, 'scrollLeft', {
      get: () => l,
      set: (v: number) => {
        l = v;
      },
      configurable: true,
    });
    Object.defineProperty(sc, 'scrollTop', {
      get: () => t,
      set: (v: number) => {
        t = v;
      },
      configurable: true,
    });
    sc.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 200 }) as DOMRect;
    return sc;
  }

  it('compensates for scroll that happens during the gesture', () => {
    const sc = scrollBox(100, 100);
    const { el, position } = setup({ scroll: sc });
    el.dispatchEvent(pe('pointerdown', 100, 100));
    tick();
    sc.scrollLeft = 150;
    sc.scrollTop = 130;
    el.dispatchEvent(pe('pointermove', 110, 110));
    tick();
    expect(position()).toEqual({ x: 60, y: 40 });
  });

  it('accepts an ElementRef as the scroll container', () => {
    const sc = scrollBox();
    const { el, position } = setup({ scroll: new ElementRef(sc) });
    el.dispatchEvent(pe('pointerdown', 100, 100));
    tick();
    sc.scrollLeft = 50;
    el.dispatchEvent(pe('pointermove', 110, 100));
    tick();
    expect(position()).toEqual({ x: 60, y: 0 });
  });

  it.each([
    ['left', { x: 5, y: 100 }, { left: 88, top: 100 }],
    ['right', { x: 195, y: 100 }, { left: 112, top: 100 }],
    ['top', { x: 100, y: 5 }, { left: 100, top: 88 }],
    ['bottom', { x: 100, y: 195 }, { left: 100, top: 112 }],
    ['middle', { x: 120, y: 120 }, { left: 100, top: 100 }],
  ])(
    'auto-scrolls by the default 12px per frame near the %s edge',
    (_, to, scroll) => {
      const sc = scrollBox(100, 100);
      const { el, position } = setup({ scroll: sc });
      drag(el, to, { x: 100, y: 100 });
      flush();
      expect({ left: sc.scrollLeft, top: sc.scrollTop }).toEqual(scroll);
      expect(position()).toEqual({
        x: to.x - 100 + scroll.left - 100,
        y: to.y - 100 + scroll.top - 100,
      });
    },
  );

  it('runs one scroll loop however many moves land near the edge', () => {
    const sc = scrollBox();
    const { el } = setup({ scroll: sc });
    drag(el, { x: 190, y: 100 }, { x: 100, y: 100 });
    el.dispatchEvent(pe('pointermove', 192, 100));
    tick();
    flush();
    expect(sc.scrollLeft).toBe(12);
  });

  it('uses scrollMargin and scrollSpeed', () => {
    const sc = scrollBox();
    const { el } = setup({ scroll: sc, scrollMargin: 5, scrollSpeed: 3 });
    drag(el, { x: 190, y: 100 }, { x: 100, y: 100 });
    flush();
    expect(sc.scrollLeft).toBe(0);
    el.dispatchEvent(pe('pointermove', 198, 100));
    tick();
    flush();
    expect(sc.scrollLeft).toBe(3);
  });
});

describe('movable: keyboard contract', () => {
  it('ignores arrows without the keyboard option', () => {
    const { el, position } = setup();
    const e = key(el, 'ArrowRight');
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(e.defaultPrevented).toBe(false);
  });

  it('steps 1px without grid or step, and prevents the page scroll', () => {
    const { el, position } = setup({ keyboard: true });
    const e = key(el, 'ArrowRight');
    expect(position()).toEqual({ x: 1, y: 0 });
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves non-arrow keys alone', () => {
    const { el, position } = setup({ keyboard: true });
    const e = key(el, 'Tab');
    expect(position()).toEqual({ x: 0, y: 0 });
    expect(e.defaultPrevented).toBe(false);
  });

  it('does nothing while disabled', () => {
    const { el, position } = setup({ keyboard: true, disabled: signal(true) });
    key(el, 'ArrowRight');
    expect(position()).toEqual({ x: 0, y: 0 });
  });

  it('clamps at the right and bottom bounds using size', () => {
    const { el, position } = setup(
      {
        keyboard: { step: 10 },
        bounds: { x: 0, y: 0, width: 30, height: 30 },
        size: { width: 10, height: 10 },
      },
      { x: 20, y: 20 },
    );
    key(el, 'ArrowRight');
    key(el, 'ArrowDown');
    expect(position()).toEqual({ x: 20, y: 20 });
  });

  it('nudges the group from its own positions and clamps members', () => {
    const a = signal<Point>({ x: 100, y: 100 });
    const b = signal<Point>({ x: 0, y: 145 });
    const { el, position } = setup(
      {
        keyboard: { step: 10 },
        group: () => [a, b],
        bounds: { x: 0, y: 0, width: 150, height: 150 },
      },
      { x: 50, y: 50 },
    );
    key(el, 'ArrowDown');
    expect(position()).toEqual({ x: 50, y: 60 });
    expect(a()).toEqual({ x: 100, y: 110 });
    expect(b()).toEqual({ x: 0, y: 150 });
  });

  it('reports the nudge to onMove', () => {
    const move = vi.fn();
    const { el } = setup({ keyboard: { step: 10 }, onMove: move });
    key(el, 'ArrowRight');
    expect(move).toHaveBeenCalledWith({
      position: { x: 10, y: 0 },
      delta: { x: 10, y: 0 },
    });
  });

  it('stops listening once the injector is destroyed', () => {
    const { el, position } = setup({ keyboard: true });
    TestBed.resetTestingModule();
    key(el, 'ArrowRight');
    expect(position()).toEqual({ x: 0, y: 0 });
  });
});

describe('Movable directive', () => {
  @Component({
    selector: 'mm-movable-host',
    imports: [Movable],
    template: `<div
      class="m"
      [mmMovable]="pos"
      [grid]="grid()"
      [bounds]="bounds()"
      [group]="group()"
      #m="mmMovable"
    ></div>`,
  })
  class Host {
    readonly pos = signal<Point>({ x: 0, y: 0 });
    readonly grid = signal<{ size: number } | undefined>(undefined);
    readonly bounds = signal<
      { x: number; y: number; width: number; height: number } | undefined
    >(undefined);
    readonly group = signal<ReturnType<typeof signal<Point>>[] | undefined>(
      undefined,
    );
    readonly dir = viewChild.required<Movable>('m');
  }

  function render() {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(Host);
    const el = fixture.nativeElement.querySelector('.m') as HTMLElement;
    return { fixture, host: fixture.componentInstance, el };
  }

  it('reads idle state before the first render without throwing', () => {
    const { fixture } = render();
    fixture.detectChanges(false);
    const dir = fixture.componentInstance.dir();
    expect(dir.moving()).toBe(false);
    expect(dir.guides()).toEqual([]);
  });

  it('drags with defaults: no keyboard, enabled, no snap to bounds', () => {
    const { fixture, host, el } = render();
    host.bounds.set({ x: 0, y: 0, width: 100, height: 100 });
    fixture.detectChanges();
    key(el, 'ArrowRight');
    expect(host.pos()).toEqual({ x: 0, y: 0 });
    drag(el, { x: 3, y: 50 });
    expect(host.dir().moving()).toBe(true);
    expect(host.pos()).toEqual({ x: 3, y: 50 });
  });

  it('honors [grid] and moves a [group] by the same delta', () => {
    const { fixture, host, el } = render();
    const other = signal<Point>({ x: 100, y: 100 });
    host.grid.set({ size: 10 });
    host.group.set([other]);
    fixture.detectChanges();
    drag(el, { x: 12, y: 8 });
    expect(host.pos()).toEqual({ x: 10, y: 10 });
    expect(other()).toEqual({ x: 110, y: 110 });
  });
});
