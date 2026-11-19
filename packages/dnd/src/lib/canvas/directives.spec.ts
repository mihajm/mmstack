import {
  Component,
  signal,
  type EnvironmentProviders,
  type Provider,
  type Type,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideDnd, type AutoScrollPlugin } from '../provide';
import type { CanvasOptions } from './controller';
import {
  Canvas,
  CanvasItem,
  CanvasResizeHandle,
  CanvasRotateHandle,
} from './directives';
import { injectCanvas } from './controller';

type Item = {
  id: string;
  frame: { x: number; y: number; width: number; height: number };
};

const ITEMS = (): Item[] => [
  { id: 'a', frame: { x: 0, y: 0, width: 50, height: 50 } },
  { id: 'b', frame: { x: 100, y: 0, width: 50, height: 50 } },
];

function pe(
  type: string,
  x: number,
  y: number,
  mods: { shiftKey?: boolean } = {},
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    button: 0,
    pointerType: 'mouse',
    shiftKey: !!mods.shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return e;
}

function click(el: Element, x: number, y: number, shiftKey = false): void {
  el.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      clientX: x,
      clientY: y,
      shiftKey,
    }),
  );
}

let opts: Partial<CanvasOptions<Item, string>> = {};

@Component({
  selector: 'mm-canvas-dir-host',
  imports: [Canvas, CanvasItem, CanvasResizeHandle, CanvasRotateHandle],
  template: `
    <div class="outer">
      <div class="surface" [mmCanvas]="board">
        @for (b of shown(); track $index) {
          <div [mmCanvasItem]="b" class="box" [attr.data-id]="b.id"></div>
        }
        <div class="bare" mmCanvasResizeHandle></div>
        <div class="ne" mmCanvasResizeHandle="ne"></div>
        <div class="rot" mmCanvasRotateHandle></div>
      </div>
    </div>
  `,
})
class Host {
  readonly boxes = signal<readonly Item[]>(ITEMS());
  readonly shown = signal<readonly Item[] | null>(null);
  readonly board = injectCanvas(this.boxes, {
    key: (b: Item) => b.id,
    frame: (b: Item) => b.frame,
    patch: (b: Item, frame) => ({ ...b, frame }),
    ...opts,
  });
  constructor() {
    this.shown.set(this.boxes());
  }
}

function render(
  o: Partial<CanvasOptions<Item, string>> = {},
  providers: (Provider | EnvironmentProviders)[] = [],
  host: Type<Host> = Host,
) {
  opts = o;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers });
  const fixture = TestBed.createComponent(host);
  fixture.detectChanges();
  TestBed.tick();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const q = (s: string) => root.querySelector(s) as HTMLElement;
  const boxEl = (i: number) => root.querySelectorAll('.box')[i] as HTMLElement;
  const fire = (el: Element, e: Event) => {
    el.dispatchEvent(e);
    TestBed.tick();
  };
  return {
    fixture,
    host: fixture.componentInstance,
    board: fixture.componentInstance.board,
    q,
    boxEl,
    fire,
  };
}

describe('canvas handle directives', () => {
  it('a bare resize handle renders as the se handle', () => {
    const { q, fixture } = render();
    expect(q('.bare').getAttribute('data-mm-canvas-resize')).toBe('se');
    expect(q('.ne').getAttribute('data-mm-canvas-resize')).toBe('ne');
    expect(q('.rot').hasAttribute('data-mm-canvas-rotate')).toBe(true);
    fixture.destroy();
  });

  it('marks the surface ready once gestures are wired', () => {
    const { q } = render();
    expect(q('.surface').hasAttribute('data-mm-canvas-ready')).toBe(true);
  });
});

describe('canvas item registration', () => {
  it('follows a key change on a reused element (track $index)', () => {
    const { host, board, boxEl, fire, fixture } = render();
    const first = boxEl(0);
    host.shown.set([...host.boxes()].reverse());
    fixture.detectChanges();
    TestBed.tick();
    expect(first.getAttribute('data-id')).toBe('b');
    expect(board.keyForElement(first)).toBe('b');
    fire(first, pe('pointerdown', 110, 10));
    fire(first, pe('pointerup', 110, 10));
    click(first, 110, 10);
    expect(board.selection.ids()).toEqual(['b']);
  });

  it('unregisters a destroyed item element', () => {
    const { host, board, boxEl, fixture } = render();
    const second = boxEl(1);
    expect(board.keyForElement(second)).toBe('b');
    host.shown.set([host.boxes()[0]]);
    fixture.detectChanges();
    TestBed.tick();
    expect(board.keyForElement(second)).toBeUndefined();
  });

  it('unregisters under the current key after a key change', () => {
    const { host, board, boxEl, fixture } = render();
    const second = boxEl(1);
    host.shown.set([host.boxes()[1]]);
    fixture.detectChanges();
    TestBed.tick();
    const first = boxEl(0);
    expect(board.keyForElement(first)).toBe('b');
    expect(board.keyForElement(second)).toBeUndefined();
    host.shown.set([]);
    fixture.detectChanges();
    TestBed.tick();
    expect(board.keyForElement(first)).toBeUndefined();
  });
});

const fakeAutoScroll = () => {
  const stops: ReturnType<typeof vi.fn>[] = [];
  const calls: Record<string, unknown>[] = [];
  const plugin = vi.fn((args: Record<string, unknown>) => {
    calls.push(args);
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  }) as unknown as AutoScrollPlugin & ReturnType<typeof vi.fn>;
  return {
    plugin,
    calls,
    stops,
    provider: provideDnd({ plugins: { autoScroll: plugin } }),
  };
};

describe('canvas surface: click selection', () => {
  const tap = (
    r: ReturnType<typeof render>,
    el: Element,
    from: { x: number; y: number },
    to = from,
    shiftKey = false,
  ) => {
    r.fire(el, pe('pointerdown', from.x, from.y, { shiftKey }));
    if (to !== from) r.fire(el, pe('pointermove', to.x, to.y, { shiftKey }));
    r.fire(el, pe('pointerup', to.x, to.y, { shiftKey }));
    click(el, to.x, to.y, shiftKey);
    TestBed.tick();
  };

  it('a click selects the item, Shift-click adds another', () => {
    const r = render();
    tap(r, r.boxEl(0), { x: 10, y: 10 });
    expect(r.board.selection.ids()).toEqual(['a']);
    tap(r, r.boxEl(1), { x: 110, y: 10 }, undefined, true);
    expect([...r.board.selection.ids()].sort()).toEqual(['a', 'b']);
  });

  it('a 2px jitter is still a click', () => {
    const r = render();
    r.board.selection.set(['a', 'b']);
    tap(r, r.boxEl(0), { x: 10, y: 10 }, { x: 12, y: 10 }, true);
    expect(r.board.selection.ids()).toEqual(['b']);
  });

  it.each([
    ['horizontally', { x: 50, y: 10 }],
    ['vertically', { x: 10, y: 50 }],
  ])('a press that moved 40px %s is a drag, not a click', (_, to) => {
    const r = render();
    r.board.selection.set(['a', 'b']);
    tap(r, r.boxEl(0), { x: 10, y: 10 }, to, true);
    expect([...r.board.selection.ids()].sort()).toEqual(['a', 'b']);
  });

  it('an empty-surface click clears; a click on a handle does not', () => {
    const r = render();
    r.board.selection.set(['a']);
    tap(r, r.q('.rot'), { x: 300, y: 300 });
    expect(r.board.selection.ids()).toEqual(['a']);
    tap(r, r.q('.bare'), { x: 300, y: 300 });
    expect(r.board.selection.ids()).toEqual(['a']);
    tap(r, r.q('.surface'), { x: 300, y: 300 });
    expect(r.board.selection.ids()).toEqual([]);
  });
});

describe('canvas surface: gesture wiring', () => {
  const drag = (r: ReturnType<typeof render>, el: Element, dx: number) => {
    r.fire(el, pe('pointerdown', 10, 10));
    r.fire(el, pe('pointermove', 10 + dx, 10));
  };

  it('stops the press from reaching outer listeners', () => {
    const r = render();
    const outer = vi.fn();
    r.q('.outer').addEventListener('pointerdown', outer);
    r.fire(r.boxEl(0), pe('pointerdown', 10, 10));
    expect(outer).not.toHaveBeenCalled();
  });

  it('pointercancel aborts the gesture without committing', () => {
    const r = render();
    drag(r, r.boxEl(0), 30);
    expect(r.board.liveFrames()?.has('a')).toBe(true);
    r.fire(r.boxEl(0), pe('pointercancel', 40, 10));
    expect(r.board.liveFrames()).toBeNull();
    expect(r.host.boxes()[0].frame.x).toBe(0);
  });

  it('destroying the surface mid-drag ends the gesture and stops auto-scroll', () => {
    const fake = fakeAutoScroll();
    const r = render({ autoScroll: {} }, [fake.provider]);
    drag(r, r.boxEl(0), 30);
    expect(fake.stops).toHaveLength(2);
    r.fixture.destroy();
    expect(r.board.liveFrames()).toBeNull();
    for (const stop of fake.stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it('starts one auto-scroll loop per axis with the resolved options', () => {
    const fake = fakeAutoScroll();
    const r = render({ autoScroll: { edge: 20 } }, [fake.provider]);
    drag(r, r.boxEl(0), 30);
    expect(fake.calls.map((c) => c['axis'])).toEqual(['x', 'y']);
    for (const c of fake.calls) {
      expect(c['element']).toBe(r.q('.surface'));
      expect(c['edge']).toBe(20);
      expect(c['speed']).toBe(16);
    }
    r.fire(r.boxEl(0), pe('pointermove', 55, 12));
    expect((fake.calls[0]['pointer'] as () => unknown)()).toEqual({
      x: 55,
      y: 12,
    });
  });

  it('feeds scroll travel into the gesture and restarts on the next drag', () => {
    const fake = fakeAutoScroll();
    const r = render({ autoScroll: {} }, [fake.provider]);
    drag(r, r.boxEl(0), 30);
    (fake.calls[0]['onScroll'] as (d: number) => void)(30);
    TestBed.tick();
    r.fire(r.boxEl(0), pe('pointerup', 40, 10));
    expect(r.host.boxes()[0].frame).toMatchObject({ x: 60, y: 0 });
    for (const stop of fake.stops) expect(stop).toHaveBeenCalledTimes(1);
    drag(r, r.boxEl(0), 30);
    expect(fake.calls).toHaveLength(4);
  });

  it('auto-scroll stays off without the canvas option', () => {
    const fake = fakeAutoScroll();
    const r = render({}, [fake.provider]);
    drag(r, r.boxEl(0), 30);
    expect(fake.plugin).not.toHaveBeenCalled();
  });

  it('auto-scroll on without a plugin still drags and commits', () => {
    const r = render({ autoScroll: {} });
    drag(r, r.boxEl(0), 30);
    r.fire(r.boxEl(0), pe('pointerup', 40, 10));
    expect(r.host.boxes()[0].frame.x).toBe(30);
  });
});

describe('canvas item: keyboard and bindings', () => {
  const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    el.dispatchEvent(e);
    TestBed.tick();
    return e;
  };
  const frameOf = (r: ReturnType<typeof render>, id: string) =>
    r.host.boxes().find((b) => b.id === id)?.frame;

  it('an arrow on an unselected item selects only it and nudges it', () => {
    const r = render();
    r.board.selection.set(['b']);
    const e = press(r.boxEl(0), 'ArrowRight');
    expect(r.board.selection.ids()).toEqual(['a']);
    expect(frameOf(r, 'a')).toMatchObject({ x: 1, y: 0 });
    expect(frameOf(r, 'b')).toMatchObject({ x: 100, y: 0 });
    expect(e.defaultPrevented).toBe(true);
  });

  it('an arrow on a selected item nudges the whole selection; Shift is the large step', () => {
    const r = render();
    r.board.selection.set(['a', 'b']);
    press(r.boxEl(0), 'ArrowDown', { shiftKey: true });
    expect(frameOf(r, 'a')).toMatchObject({ x: 0, y: 10 });
    expect(frameOf(r, 'b')).toMatchObject({ x: 100, y: 10 });
  });

  it.each([['metaKey'], ['ctrlKey']])('%s+arrow resizes', (mod) => {
    const r = render();
    press(r.boxEl(0), 'ArrowRight', { [mod]: true });
    expect(frameOf(r, 'a')).toMatchObject({ x: 0, width: 51, height: 50 });
  });

  it('non-arrow keys and keyboard: false do nothing', () => {
    const r = render();
    const e = press(r.boxEl(0), 'Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(frameOf(r, 'a')).toMatchObject({ x: 0, y: 0 });
    const off = render({ keyboard: false });
    const e2 = press(off.boxEl(0), 'ArrowRight');
    expect(e2.defaultPrevented).toBe(false);
    expect(frameOf(off, 'a')).toMatchObject({ x: 0, y: 0 });
    expect(off.boxEl(0).getAttribute('tabindex')).toBeNull();
    expect(r.boxEl(0).getAttribute('tabindex')).toBe('0');
  });

  it('a nudge pinned against the bounds does not prevent the key', () => {
    const r = render({ bounds: { x: 0, y: 0, width: 150, height: 50 } });
    const e = press(r.boxEl(1), 'ArrowRight');
    expect(e.defaultPrevented).toBe(false);
    expect(frameOf(r, 'b')).toMatchObject({ x: 100 });
  });

  it('announces a keyboard transform through the announce plugin', () => {
    const announce = vi.fn();
    const r = render(
      { announceTransform: ({ frame }) => `at ${frame.x},${frame.y}` },
      [provideDnd({ plugins: { announce } })],
    );
    press(r.boxEl(0), 'ArrowRight');
    expect(announce).toHaveBeenCalledWith('at 1,0');
  });

  it('renders the frame, selection and drag state as host bindings', () => {
    const r = render();
    const el = r.boxEl(1);
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe('0px');
    expect(el.style.width).toBe('50px');
    expect(el.style.height).toBe('50px');
    expect(el.classList.contains('mm-canvas-selected')).toBe(false);
    r.board.selection.set(['b']);
    r.fixture.detectChanges();
    expect(el.classList.contains('mm-canvas-selected')).toBe(true);
    r.fire(el, pe('pointerdown', 110, 10));
    r.fire(el, pe('pointermove', 130, 10));
    r.fixture.detectChanges();
    expect(el.classList.contains('mm-canvas-dragging')).toBe(true);
    expect(el.style.zIndex).toBe('1');
    expect(el.style.transform).toContain('translate');
  });

  it('resize and rotate grips start at once under a touch long-press', () => {
    const r = render({ touchActivation: { delay: 250 } });
    r.board.selection.set(['a']);
    r.fixture.detectChanges();
    const grip = r.q('.bare');
    const touch = (type: string, x: number, y: number) => {
      const e = pe(type, x, y) as Event & Record<string, unknown>;
      e['pointerType'] = 'touch';
      r.fire(grip, e);
    };
    touch('pointerdown', 50, 50);
    touch('pointermove', 70, 70);
    expect(r.board.liveFrames()?.has('a')).toBe(true);
  });
});
