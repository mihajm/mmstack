import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { pointerDrag } from './pointer-drag';

function pe(
  type: string,
  opts: {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    button?: number;
    pointerType?: string;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
  } = {},
): Event {
  // jsdom lacks a full PointerEvent — synthesize the fields the sensor reads.
  const e = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  e['pointerId'] = opts.pointerId ?? 1;
  e['clientX'] = opts.clientX ?? 0;
  e['clientY'] = opts.clientY ?? 0;
  e['pageX'] = opts.clientX ?? 0;
  e['pageY'] = opts.clientY ?? 0;
  e['button'] = opts.button ?? 0;
  e['pointerType'] = opts.pointerType ?? 'mouse';
  e['shiftKey'] = !!opts.shiftKey;
  e['altKey'] = !!opts.altKey;
  e['ctrlKey'] = !!opts.ctrlKey;
  e['metaKey'] = !!opts.metaKey;
  return e;
}

function setup(
  opts: Parameters<typeof pointerDrag>[0] = {},
  el = document.createElement('div'),
) {
  document.body.appendChild(el);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: ElementRef, useValue: new ElementRef(el) }],
  });
  const drag = TestBed.runInInjectionContext(() => pointerDrag(opts));
  return { drag, el };
}

describe('pointerDrag', () => {
  it('starts idle', () => {
    const { drag } = setup();
    const s = drag.unthrottled();
    expect(s.active).toBe(false);
    expect(s.pointerId).toBeNull();
    expect(s.button).toBe(-1);
  });

  it('stopPropagation: claims the pointerdown when opted in (inner wins over outer)', () => {
    const { drag, el } = setup({ stopPropagation: true });
    const e = pe('pointerdown', { pointerId: 1 });
    let stopped = false;
    e.stopPropagation = () => (stopped = true);
    el.dispatchEvent(e);
    expect(stopped).toBe(true);
    expect(drag.unthrottled().pointerId).toBe(1); // gesture still started
  });

  it('does not stop propagation by default', () => {
    const { el } = setup();
    const e = pe('pointerdown', { pointerId: 1 });
    let stopped = false;
    e.stopPropagation = () => (stopped = true);
    el.dispatchEvent(e);
    expect(stopped).toBe(false);
  });

  it('exposes the pointerType (touch/pen/mouse) for the gesture', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { pointerType: 'touch', pointerId: 7 }));
    expect(drag.unthrottled().pointerType).toBe('touch');
    el.dispatchEvent(pe('pointerup', { pointerId: 7 }));
    expect(drag.unthrottled().pointerType).toBe(''); // reset when idle
  });

  it('records a pending (inactive) gesture on pointerdown', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 5, clientY: 6, pointerId: 2 }));
    const s = drag.unthrottled();
    expect(s.active).toBe(false);
    expect(s.pointerId).toBe(2);
    expect(s.start).toEqual({ x: 5, y: 6 });
    expect(s.current).toEqual({ x: 5, y: 6 });
    expect(s.delta).toEqual({ x: 0, y: 0 });
  });

  it('stays inactive below the activation threshold, activates past it', () => {
    const { drag, el } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));

    el.dispatchEvent(pe('pointermove', { clientX: 2, clientY: 0 }));
    expect(drag.unthrottled().active).toBe(false);
    expect(drag.unthrottled().delta).toEqual({ x: 2, y: 0 });

    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
    const s = drag.unthrottled();
    expect(s.active).toBe(true);
    expect(s.delta).toEqual({ x: 10, y: 0 });
    expect(s.current).toEqual({ x: 10, y: 0 });
  });

  it('stays active once activated, even if it returns within the threshold', () => {
    const { drag, el } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 1, clientY: 0 }));
    expect(drag.unthrottled().active).toBe(true);
  });

  it('captures modifier keys on move', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0, shiftKey: true, altKey: true }));
    const m = drag.unthrottled().modifiers;
    expect(m.shift).toBe(true);
    expect(m.alt).toBe(true);
    expect(m.ctrl).toBe(false);
  });

  it('resets to idle on pointerup', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
    el.dispatchEvent(pe('pointerup', { clientX: 10, clientY: 0 }));
    expect(drag.unthrottled().active).toBe(false);
    expect(drag.unthrottled().pointerId).toBeNull();
  });

  it('preserves the down-button across the gesture (pointermove button is -1) (#6)', () => {
    const { drag, el } = setup({ activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0, button: 0 }));
    // a real pointermove reports button === -1; the sensor must keep the down-button
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0, button: -1 }));
    expect(drag.unthrottled().active).toBe(true);
    expect(drag.unthrottled().button).toBe(0);
  });

  it('flushes terminal IDLE immediately, not on the trailing edge (#12)', () => {
    const { drag, el } = setup({ throttle: 100, activationThreshold: 3 });
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 20, clientY: 0 }));
    el.dispatchEvent(pe('pointerup', { clientX: 20, clientY: 0 }));
    // throttled view (not unthrottled) reflects IDLE right away
    expect(drag().active).toBe(false);
    expect(drag().pointerId).toBeNull();
  });

  it('cancels on Escape', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
    expect(drag.unthrottled().active).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drag.unthrottled().active).toBe(false);
    expect(drag.unthrottled().pointerId).toBeNull();
  });

  it('cancel() aborts the gesture imperatively', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
    drag.cancel();
    expect(drag.unthrottled().active).toBe(false);
  });

  // consumers branch on this to tell "drop here" from "abort" — see @mmstack/dnd
  describe('cancelled (end reason)', () => {
    it('a normal pointerup ends with cancelled: false', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
      el.dispatchEvent(pe('pointerup', { clientX: 10, clientY: 0 }));
      expect(drag.unthrottled().cancelled).toBe(false);
    });

    it('Escape ends with cancelled: true', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(drag.unthrottled().active).toBe(false);
      expect(drag.unthrottled().cancelled).toBe(true);
    });

    it('pointercancel ends with cancelled: true', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
      el.dispatchEvent(pe('pointercancel', { clientX: 10, clientY: 0 }));
      expect(drag.unthrottled().cancelled).toBe(true);
    });

    it('cancel() ends with cancelled: true', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      drag.cancel();
      expect(drag.unthrottled().cancelled).toBe(true);
    });

    it('is sticky until the next pointerdown, which clears it', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(drag.unthrottled().cancelled).toBe(true);

      el.dispatchEvent(pe('pointerdown', { clientX: 5, clientY: 5, pointerId: 2 }));
      expect(drag.unthrottled().cancelled).toBe(false);
      el.dispatchEvent(pe('pointermove', { clientX: 20, clientY: 5, pointerId: 2 }));
      el.dispatchEvent(pe('pointerup', { clientX: 20, clientY: 5, pointerId: 2 }));
      expect(drag.unthrottled().cancelled).toBe(false);
    });
  });

  it('ignores non-allowed buttons', () => {
    const { drag, el } = setup({ buttons: [0] });
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0, button: 2 }));
    expect(drag.unthrottled().pointerId).toBeNull();
  });

  it('honours handleSelector (delegated handles)', () => {
    const el = document.createElement('div');
    const handle = document.createElement('span');
    handle.className = 'grip';
    const other = document.createElement('span');
    el.append(handle, other);
    const { drag } = setup({ handleSelector: '.grip' }, el);

    // pointerdown on a non-handle child → ignored
    other.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    expect(drag.unthrottled().pointerId).toBeNull();

    // pointerdown on the handle → starts
    handle.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0, pointerId: 3 }));
    expect(drag.unthrottled().pointerId).toBe(3);
  });

  it('ignores moves from a different pointer id', () => {
    const { drag, el } = setup();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 }));
    el.dispatchEvent(pe('pointermove', { clientX: 50, clientY: 0, pointerId: 9 }));
    expect(drag.unthrottled().current).toEqual({ x: 0, y: 0 });
  });

  it('reports page coordinates when configured', () => {
    const { drag, el } = setup({ coordinateSpace: 'page' });
    el.dispatchEvent(pe('pointerdown', { clientX: 3, clientY: 4 }));
    expect(drag.unthrottled().start).toEqual({ x: 3, y: 4 });
  });

  it('re-attaches when a signal target changes', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const target = signal<HTMLElement | null>(a);
    TestBed.resetTestingModule();
    const drag = TestBed.runInInjectionContext(() => pointerDrag({ target }));
    TestBed.tick();

    a.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 1 }));
    expect(drag.unthrottled().pointerId).toBe(1);
    a.dispatchEvent(pe('pointerup', { clientX: 1, clientY: 1, pointerId: 1 }));

    target.set(b);
    TestBed.tick();
    // old target no longer starts gestures
    a.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 2 }));
    expect(drag.unthrottled().pointerId).toBeNull();
    // new target does
    b.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 3 }));
    expect(drag.unthrottled().pointerId).toBe(3);
  });

  it('is inert on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
      ],
    });
    const drag = TestBed.runInInjectionContext(() => pointerDrag());
    expect(drag().active).toBe(false);
    expect(() => drag.cancel()).not.toThrow();
  });
});
