import { TestBed } from '@angular/core/testing';
import type { PointerDragState } from '@mmstack/primitives';

import { driveGesture, type GestureAdapter } from './gesture';
import {
  gatedPointerDrag,
  resolveTouchActivation,
  surfaceTouchAction,
} from './touch-activation';

function pe(
  type: string,
  x: number,
  y: number,
  pointerType = 'touch',
  pointerId = 1,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  Object.assign(e, {
    pointerId,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    button: 0,
    pointerType,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  });
  return e;
}

/** A cancelable touchmove; returns whether a listener prevented it (page scroll blocked). */
function touchMoveBlocked(el: HTMLElement): boolean {
  const e = new Event('touchmove', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

function contextMenuBlocked(el: HTMLElement): boolean {
  const e = new Event('contextmenu', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

type Log = string[];

function setup(
  opts: Parameters<typeof driveGesture>[2] = {
    touchActivation: { delay: 300, tolerance: 5 },
    activationThreshold: 3,
  },
) {
  const el = document.createElement('div');
  const child = document.createElement('span');
  el.appendChild(child);
  document.body.appendChild(el);
  const log: Log = [];
  const adapter: GestureAdapter = {
    begin: (_o, start) => {
      log.push(`begin ${start.x},${start.y}`);
      return true;
    },
    move: (p) => log.push(`move ${p.x},${p.y}`),
    end: () => log.push('end'),
    cancel: () => log.push('cancel'),
  };
  TestBed.runInInjectionContext(() => driveGesture(el, adapter, opts));
  TestBed.tick();
  const fire = (e: Event) => {
    child.dispatchEvent(e);
    TestBed.tick();
  };
  return { el, child, log, fire };
}

describe('touch long-press activation (driveGesture)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  it('a mouse press is never delayed', () => {
    const { log, fire } = setup();
    fire(pe('pointerdown', 0, 0, 'mouse'));
    fire(pe('pointermove', 10, 0, 'mouse'));
    expect(log).toEqual(['begin 0,0', 'move 10,0']);
    fire(pe('pointerup', 10, 0, 'mouse'));
    expect(log.at(-1)).toBe('end');
  });

  it('a touch press inside touchImmediateSelector starts at once; elsewhere it still waits', () => {
    const { el, child, log, fire } = setup({
      touchActivation: { delay: 300, tolerance: 5 },
      activationThreshold: 3,
      touchImmediateSelector: '.grip',
    });
    child.className = 'grip';
    fire(pe('pointerdown', 0, 0));
    expect(touchMoveBlocked(el)).toBe(true); // armed at once: the grip owns the touch
    fire(pe('pointermove', 10, 0));
    expect(log).toEqual(['begin 0,0', 'move 10,0']);
    fire(pe('pointerup', 10, 0));
    expect(log.at(-1)).toBe('end');

    // the same touch on the surface outside the grip waits for the long-press
    log.length = 0;
    const press = (e: Event) => {
      el.dispatchEvent(e);
      TestBed.tick();
    };
    press(pe('pointerdown', 50, 50, 'touch', 2));
    expect(touchMoveBlocked(el)).toBe(false);
    press(pe('pointermove', 52, 52, 'touch', 2));
    advance(299);
    press(pe('pointermove', 53, 53, 'touch', 2)); // 4.2px: inside tolerance, past threshold
    expect(log).toEqual([]);
    advance(1);
    expect(log).toEqual(['begin 50,50', 'move 53,53']);
  });

  it('a mouse press on a non-immediate element is still never delayed', () => {
    const { el, log } = setup({
      touchActivation: { delay: 300, tolerance: 5 },
      activationThreshold: 3,
      touchImmediateSelector: '.grip',
    });
    el.dispatchEvent(pe('pointerdown', 0, 0, 'mouse'));
    TestBed.tick();
    el.dispatchEvent(pe('pointermove', 10, 0, 'mouse'));
    TestBed.tick();
    expect(log).toEqual(['begin 0,0', 'move 10,0']);
  });

  it('a pen press is never delayed', () => {
    const { log, fire } = setup();
    fire(pe('pointerdown', 0, 0, 'pen'));
    fire(pe('pointermove', 0, 10, 'pen'));
    expect(log).toEqual(['begin 0,0', 'move 0,10']);
  });

  it('a touch press waits the full delay, then drags as usual and blocks the page scroll', () => {
    const { el, log, fire } = setup();
    fire(pe('pointerdown', 0, 0));
    expect(touchMoveBlocked(el)).toBe(false); // pending: the page may scroll
    fire(pe('pointermove', 2, 2)); // within tolerance, under the threshold
    advance(299);
    fire(pe('pointermove', 3, 3)); // past the threshold but not yet armed
    expect(log).toEqual([]);
    expect(touchMoveBlocked(el)).toBe(false);

    advance(1); // armed: already past the threshold, so the drag starts now
    expect(log).toEqual(['begin 0,0', 'move 3,3']);
    expect(touchMoveBlocked(el)).toBe(true);

    fire(pe('pointermove', 40, 60));
    expect(log.at(-1)).toBe('move 40,60');
    expect(touchMoveBlocked(el)).toBe(true);
    fire(pe('pointerup', 40, 60));
    expect(log.at(-1)).toBe('end');
    expect(touchMoveBlocked(el)).toBe(false); // idle again
  });

  it('after the delay a resting touch still needs the activation threshold', () => {
    const { log, fire } = setup();
    fire(pe('pointerdown', 10, 10));
    advance(300);
    expect(log).toEqual([]);
    fire(pe('pointermove', 11, 11)); // under 3px
    expect(log).toEqual([]);
    fire(pe('pointermove', 10, 14));
    expect(log).toEqual(['begin 10,10', 'move 10,14']);
  });

  it('moving past the tolerance during the delay abandons the press for good', () => {
    const { el, log, fire } = setup();
    fire(pe('pointerdown', 0, 0));
    fire(pe('pointermove', 0, 6)); // > 5px: a scroll, not a drag
    expect(touchMoveBlocked(el)).toBe(false);
    advance(1000);
    fire(pe('pointermove', 0, 80));
    fire(pe('pointerup', 0, 80));
    expect(log).toEqual([]);
    expect(touchMoveBlocked(el)).toBe(false);
  });

  it('the tolerance is inclusive: exactly `tolerance` px keeps the press', () => {
    const { log, fire } = setup();
    fire(pe('pointerdown', 0, 0));
    fire(pe('pointermove', 3, 4)); // 5px
    advance(300);
    expect(log).toEqual(['begin 0,0', 'move 3,4']);
  });

  it.each([
    ['pointerup', (f: (e: Event) => void) => f(pe('pointerup', 1, 1))],
    ['pointercancel', (f: (e: Event) => void) => f(pe('pointercancel', 1, 1))],
    [
      'Escape',
      (f: (e: Event) => void) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        TestBed.tick();
        f(pe('pointermove', 1, 1)); // ignored: the gesture is gone
      },
    ],
  ] as const)('%s during the delay cancels the pending press', (_, end) => {
    const { el, log, fire } = setup();
    fire(pe('pointerdown', 0, 0));
    end(fire);
    advance(300);
    fire(pe('pointermove', 30, 30));
    expect(log).toEqual([]);
    expect(touchMoveBlocked(el)).toBe(false);
    // the surface is reusable straight away
    fire(pe('pointerdown', 0, 0, 'mouse', 2));
    fire(pe('pointermove', 10, 0, 'mouse', 2));
    expect(log).toEqual(['begin 0,0', 'move 10,0']);
  });

  it('a fresh touch restarts the full delay (no timer leaks across presses)', () => {
    const { log, fire } = setup();
    fire(pe('pointerdown', 0, 0));
    advance(200);
    fire(pe('pointerup', 0, 0));
    fire(pe('pointerdown', 0, 0, 'touch', 2));
    advance(200); // 400ms since the first press, 200ms into this one
    fire(pe('pointermove', 0, 10, 'touch', 2)); // > tolerance: still pending, so abandoned
    advance(500);
    fire(pe('pointermove', 0, 20, 'touch', 2));
    expect(log).toEqual([]);
  });

  it('blocks the context menu for a touch press, never for a mouse one', () => {
    const { el, fire } = setup();
    expect(contextMenuBlocked(el)).toBe(false);
    fire(pe('pointerdown', 0, 0));
    expect(contextMenuBlocked(el)).toBe(true);
    fire(pe('pointerup', 0, 0));
    expect(contextMenuBlocked(el)).toBe(false);
    fire(pe('pointerdown', 0, 0, 'mouse'));
    expect(contextMenuBlocked(el)).toBe(false);
  });

  it('off by default: a touch press starts immediately and nothing blocks the page', () => {
    const { el, log, fire } = setup({ activationThreshold: 3 });
    fire(pe('pointerdown', 0, 0));
    fire(pe('pointermove', 0, 10));
    expect(log).toEqual(['begin 0,0', 'move 0,10']);
    expect(touchMoveBlocked(el)).toBe(false);
    expect(contextMenuBlocked(el)).toBe(false);
  });

  it('`false` and a non-positive delay mean off', () => {
    for (const touchActivation of [false, { delay: 0 }] as const) {
      const { log, fire } = setup({ activationThreshold: 3, touchActivation });
      fire(pe('pointerdown', 0, 0));
      fire(pe('pointermove', 0, 10));
      expect(log).toEqual(['begin 0,0', 'move 0,10']);
      fire(pe('pointerup', 0, 10));
    }
  });
});

describe('gatedPointerDrag', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('onChange sees gated states and the arming, synchronously and in order', () => {
    const el = document.createElement('div');
    const seen: Pick<PointerDragState, 'active' | 'pointerId'>[] = [];
    const drag = TestBed.runInInjectionContext(() =>
      gatedPointerDrag({
        target: el,
        activationThreshold: 1,
        touchActivation: { delay: 100, tolerance: 5 },
        onChange: (s) =>
          seen.push({ active: s.active, pointerId: s.pointerId }),
      }),
    );
    el.dispatchEvent(pe('pointerdown', 0, 0));
    el.dispatchEvent(pe('pointermove', 2, 0));
    expect(seen).toEqual([
      { active: false, pointerId: 1 },
      { active: false, pointerId: 1 }, // past the threshold, held back
    ]);
    expect(drag.unthrottled().active).toBe(false);
    vi.advanceTimersByTime(100);
    expect(seen.at(-1)).toEqual({ active: true, pointerId: 1 });
    expect(drag.unthrottled().active).toBe(true);
    el.dispatchEvent(pe('pointerup', 2, 0));
    expect(seen.at(-1)).toEqual({ active: false, pointerId: null });
    expect(drag.unthrottled().active).toBe(false);
  });

  it('the arming timer is cleared on destroy', () => {
    const el = document.createElement('div');
    const seen: boolean[] = [];
    TestBed.runInInjectionContext(() =>
      gatedPointerDrag({
        target: el,
        touchActivation: { delay: 100, tolerance: 5 },
        onChange: (s) => seen.push(s.active),
      }),
    );
    el.dispatchEvent(pe('pointerdown', 0, 0));
    TestBed.resetTestingModule();
    const before = seen.length;
    vi.advanceTimersByTime(500);
    expect(seen.slice(before)).not.toContain(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveTouchActivation / surfaceTouchAction', () => {
  it('resolves the tolerance default and treats off values as null', () => {
    expect(resolveTouchActivation({ delay: 250 })).toEqual({
      delay: 250,
      tolerance: 5,
    });
    expect(resolveTouchActivation({ delay: 250, tolerance: 12 })).toEqual({
      delay: 250,
      tolerance: 12,
    });
    expect(resolveTouchActivation({ delay: 250, tolerance: -1 })).toEqual({
      delay: 250,
      tolerance: 0,
    });
    expect(resolveTouchActivation(undefined)).toBeNull();
    expect(resolveTouchActivation(false)).toBeNull();
    expect(resolveTouchActivation({ delay: 0 })).toBeNull();
    expect(resolveTouchActivation({ delay: Number.NaN })).toBeNull();
  });

  it('a long-press surface allows panning; otherwise the fallback stands', () => {
    expect(surfaceTouchAction({ delay: 1, tolerance: 5 }, 'none')).toBe(
      'manipulation',
    );
    expect(surfaceTouchAction(null, 'none')).toBe('none');
    expect(surfaceTouchAction(null, 'pan-x')).toBe('pan-x');
  });
});
