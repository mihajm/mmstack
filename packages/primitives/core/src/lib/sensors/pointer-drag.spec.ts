import { ElementRef, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { pointerDrag } from './pointer-drag';

function pe(
  type: string,
  opts: {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    pageX?: number;
    pageY?: number;
    button?: number;
    pointerType?: string;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
  } = {},
): Event {
  // jsdom lacks a full PointerEvent — synthesize the fields the sensor reads.
  const e = new Event(type, { bubbles: true }) as Event &
    Record<string, unknown>;
  e['pointerId'] = opts.pointerId ?? 1;
  e['clientX'] = opts.clientX ?? 0;
  e['clientY'] = opts.clientY ?? 0;
  e['pageX'] = opts.pageX ?? opts.clientX ?? 0;
  e['pageY'] = opts.pageY ?? opts.clientY ?? 0;
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
  it('reports every transition and the release point without an Angular tick', () => {
    const changes: { active: boolean; x: number; pointerId: number | null }[] =
      [];
    const { el } = setup({
      onChange: (s) =>
        changes.push({
          active: s.active,
          x: s.current.x,
          pointerId: s.pointerId,
        }),
    });
    el.dispatchEvent(pe('pointerdown', { clientX: 10 }));
    el.dispatchEvent(pe('pointermove', { clientX: 30 }));
    el.dispatchEvent(pe('pointerup', { clientX: 80 }));
    expect(changes).toEqual([
      { active: false, x: 10, pointerId: 1 },
      { active: true, x: 30, pointerId: 1 },
      { active: true, x: 80, pointerId: 1 },
      { active: false, x: 0, pointerId: null },
    ]);
  });

  it('reports cancellation once without turning it into a final movement', () => {
    const changed = vi.fn();
    const { drag, el } = setup({ onChange: changed });
    el.dispatchEvent(pe('pointerdown'));
    el.dispatchEvent(pe('pointermove', { clientX: 20 }));
    changed.mockClear();
    el.dispatchEvent(pe('pointercancel', { clientX: 100 }));
    drag.cancel();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0]).toMatchObject({
      active: false,
      pointerId: null,
      cancelled: true,
    });
  });

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

  describe('capture phase (shielded surfaces)', () => {
    function shielded(opts: Parameters<typeof pointerDrag>[0] = {}) {
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      const { drag } = setup(opts, el);
      // The editor-shield scenario: a capture-phase listener on the surface
      // stops propagation before the press can reach content or bubble back.
      el.addEventListener('pointerdown', (e) => e.stopPropagation(), {
        capture: true,
      });
      return { drag, el, child };
    }

    it('a bubble-phase sensor never sees a shielded press (the failure mode)', () => {
      const { drag, child } = shielded();
      child.dispatchEvent(pe('pointerdown', { pointerId: 4 }));
      expect(drag.unthrottled().pointerId).toBeNull();
    });

    it('capture: true observes the press despite the shield', () => {
      const { drag, child } = shielded({ capture: true });
      child.dispatchEvent(
        pe('pointerdown', { pointerId: 4, clientX: 3, clientY: 4 }),
      );
      const s = drag.unthrottled();
      expect(s.pointerId).toBe(4);
      expect(s.start).toEqual({ x: 3, y: 4 });
      expect(s.origin).toBe(child);
    });
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
    el.dispatchEvent(
      pe('pointerdown', { clientX: 5, clientY: 6, pointerId: 2 }),
    );
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
    el.dispatchEvent(
      pe('pointermove', {
        clientX: 10,
        clientY: 0,
        shiftKey: true,
        altKey: true,
      }),
    );
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
    el.dispatchEvent(
      pe('pointermove', { clientX: 10, clientY: 0, button: -1 }),
    );
    expect(drag.unthrottled().active).toBe(true);
    expect(drag.unthrottled().button).toBe(0);
  });

  it('flushes terminal IDLE immediately, not on the trailing edge (#12)', () => {
    const { drag, el } = setup({ throttle: 100, activationThreshold: 3 });
    expect(drag().pointerId).toBeNull();
    el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
    el.dispatchEvent(pe('pointermove', { clientX: 20, clientY: 0 }));
    // read inside the throttle window so the view holds a non-idle value
    expect(drag().pointerId).toBe(1);
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

      el.dispatchEvent(
        pe('pointerdown', { clientX: 5, clientY: 5, pointerId: 2 }),
      );
      expect(drag.unthrottled().cancelled).toBe(false);
      el.dispatchEvent(
        pe('pointermove', { clientX: 20, clientY: 5, pointerId: 2 }),
      );
      expect(drag.unthrottled().cancelled).toBe(false);
      el.dispatchEvent(
        pe('pointerup', { clientX: 20, clientY: 5, pointerId: 2 }),
      );
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
    handle.dispatchEvent(
      pe('pointerdown', { clientX: 0, clientY: 0, pointerId: 3 }),
    );
    expect(drag.unthrottled().pointerId).toBe(3);
  });

  it('ignores moves from a different pointer id', () => {
    const { drag, el } = setup();
    el.dispatchEvent(
      pe('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 }),
    );
    el.dispatchEvent(
      pe('pointermove', { clientX: 50, clientY: 0, pointerId: 9 }),
    );
    expect(drag.unthrottled().current).toEqual({ x: 0, y: 0 });
  });

  it.each([
    [undefined, { x: 1, y: 2 }, { x: 11, y: 2 }],
    ['client', { x: 1, y: 2 }, { x: 11, y: 2 }],
    ['page', { x: 101, y: 202 }, { x: 111, y: 202 }],
  ] as const)(
    'reports %s coordinates for start, current and delta',
    (coordinateSpace, start, current) => {
      const { drag, el } = setup({ coordinateSpace });
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 2, pageX: 101, pageY: 202 }),
      );
      el.dispatchEvent(
        pe('pointermove', { clientX: 11, clientY: 2, pageX: 111, pageY: 202 }),
      );
      expect(drag.unthrottled()).toMatchObject({
        start,
        current,
        delta: { x: 10, y: 0 },
      });
    },
  );

  it('re-attaches when a signal target changes', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const target = signal<HTMLElement | null>(a);
    TestBed.resetTestingModule();
    const drag = TestBed.runInInjectionContext(() => pointerDrag({ target }));
    TestBed.tick();

    a.dispatchEvent(
      pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 1 }),
    );
    expect(drag.unthrottled().pointerId).toBe(1);
    a.dispatchEvent(pe('pointerup', { clientX: 1, clientY: 1, pointerId: 1 }));

    target.set(b);
    TestBed.tick();
    // old target no longer starts gestures
    a.dispatchEvent(
      pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 2 }),
    );
    expect(drag.unthrottled().pointerId).toBeNull();
    // new target does
    b.dispatchEvent(
      pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 3 }),
    );
    expect(drag.unthrottled().pointerId).toBe(3);
  });

  it('is inert on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: ElementRef,
          useValue: new ElementRef(document.createElement('div')),
        },
      ],
    });
    const host = TestBed.inject(ElementRef).nativeElement as HTMLElement;
    const drag = TestBed.runInInjectionContext(() => pointerDrag());
    host.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1 }));
    expect(drag().active).toBe(false);
    expect(drag().pointerId).toBeNull();
    expect(drag.unthrottled).toBe(drag);
    expect(() => drag.cancel()).not.toThrow();
  });

  describe('contract', () => {
    const IDLE_SHAPE = {
      active: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 },
      delta: { x: 0, y: 0 },
      pointerId: null,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      button: -1,
      pointerType: '',
      origin: null,
      cancelled: false,
    };
    const escape = () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    it('has the documented idle shape, and the same with cancelled after an abort', () => {
      const { drag, el } = setup();
      expect(drag()).toEqual(IDLE_SHAPE);
      el.dispatchEvent(pe('pointerdown', { clientX: 4, clientY: 4 }));
      escape();
      expect(drag.unthrottled()).toEqual({ ...IDLE_SHAPE, cancelled: true });
    });

    it('keeps the same state object for an identical repeat move', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
      const before = drag.unthrottled();
      el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
      expect(drag.unthrottled()).toBe(before);
    });

    it('activates on a zero-distance move with activationThreshold: 0', () => {
      const { drag, el } = setup({ activationThreshold: 0 });
      el.dispatchEvent(pe('pointerdown', { clientX: 5, clientY: 5 }));
      el.dispatchEvent(pe('pointermove', { clientX: 5, clientY: 5 }));
      expect(drag.unthrottled().active).toBe(true);
    });

    it('tracks and activates on a vertical-only drag', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 0, clientY: 10 }));
      expect(drag.unthrottled()).toMatchObject({
        active: true,
        current: { x: 0, y: 10 },
        delta: { x: 0, y: 10 },
      });
    });

    it.each(['shift', 'alt', 'ctrl', 'meta'] as const)(
      'updates modifiers when only %s changes, without movement',
      (key) => {
        const { drag, el } = setup();
        el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
        el.dispatchEvent(pe('pointermove', { clientX: 10, clientY: 0 }));
        el.dispatchEvent(
          pe('pointermove', { clientX: 10, clientY: 0, [`${key}Key`]: true }),
        );
        expect(drag.unthrottled().modifiers[key]).toBe(true);
      },
    );

    it('returns an inert idle signal with no target and no host element', () => {
      TestBed.resetTestingModule();
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        const drag = TestBed.runInInjectionContext(() => pointerDrag());
        expect(drag()).toEqual(IDLE_SHAPE);
      } finally {
        warn.mockRestore();
      }
    });

    describe('throttle', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('shows the pointerdown on the throttled view immediately', () => {
        const { drag, el } = setup({ throttle: 100 });
        expect(drag().pointerId).toBeNull();
        el.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1 }));
        expect(drag().pointerId).toBe(1);
      });

      it('holds a move inside the window and delivers it on the trailing edge', () => {
        const { drag, el } = setup({ throttle: 100 });
        expect(drag().pointerId).toBeNull();
        el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
        expect(drag().current.x).toBe(0);
        el.dispatchEvent(pe('pointermove', { clientX: 20, clientY: 0 }));
        expect(drag.unthrottled().current.x).toBe(20);
        expect(drag().current.x).toBe(0);
        vi.advanceTimersByTime(100);
        expect(drag().current.x).toBe(20);
      });
    });

    it('measures delta from a non-origin start', () => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 5, clientY: 6 }));
      el.dispatchEvent(pe('pointermove', { clientX: 15, clientY: 26 }));
      expect(drag.unthrottled().delta).toEqual({ x: 10, y: 20 });
    });

    it('activates on a move of exactly activationThreshold pixels', () => {
      const { drag, el } = setup({ activationThreshold: 3 });
      el.dispatchEvent(pe('pointerdown', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(pe('pointermove', { clientX: 3, clientY: 0 }));
      expect(drag.unthrottled().active).toBe(true);
    });

    it('keeps the first pointer when a second pointer goes down, up or cancels', () => {
      const { drag, el } = setup();
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 1 }),
      );
      el.dispatchEvent(
        pe('pointerdown', { clientX: 9, clientY: 9, pointerId: 2 }),
      );
      expect(drag.unthrottled()).toMatchObject({
        pointerId: 1,
        start: { x: 1, y: 1 },
      });
      el.dispatchEvent(pe('pointerup', { pointerId: 2 }));
      el.dispatchEvent(pe('pointercancel', { pointerId: 2 }));
      el.dispatchEvent(pe('lostpointercapture', { pointerId: 2 }));
      expect(drag.unthrottled().pointerId).toBe(1);
      el.dispatchEvent(
        pe('pointerup', { clientX: 1, clientY: 1, pointerId: 1 }),
      );
      expect(drag.unthrottled()).toEqual(IDLE_SHAPE);
    });

    it.each(['Shift', 'a', ' '])('does not cancel on the %j key', (key) => {
      const { drag, el } = setup();
      el.dispatchEvent(pe('pointerdown', { clientX: 1, clientY: 1 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      expect(drag.unthrottled().pointerId).toBe(1);
    });

    it('captures the pointer on pointerdown', () => {
      const { el } = setup();
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 5 }),
      );
      expect(el.hasPointerCapture(5)).toBe(true);
    });

    it('ends cancelled when the target loses capture', () => {
      const { drag, el } = setup();
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 5 }),
      );
      el.dispatchEvent(pe('lostpointercapture', { pointerId: 5 }));
      expect(drag.unthrottled()).toEqual({ ...IDLE_SHAPE, cancelled: true });
    });

    it.each<[string, (ctx: { drag: ReturnType<typeof pointerDrag> }) => void]>([
      ['Escape', () => escape()],
      ['cancel()', ({ drag }) => drag.cancel()],
    ])('releases pointer capture on %s', (_, abort) => {
      const { drag, el } = setup();
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 5 }),
      );
      abort({ drag });
      expect(el.hasPointerCapture(5)).toBe(false);
    });

    function signalTarget() {
      const a = document.createElement('div');
      const b = document.createElement('div');
      document.body.append(a, b);
      const target = signal<HTMLElement | null>(null);
      TestBed.resetTestingModule();
      const changes: boolean[] = [];
      const drag = TestBed.runInInjectionContext(() =>
        pointerDrag({ target, onChange: (st) => changes.push(st.cancelled) }),
      );
      return { a, b, target, drag, changes };
    }

    it('tolerates a null signal target, then attaches once it resolves', () => {
      const { a, target, drag } = signalTarget();
      expect(() => TestBed.tick()).not.toThrow();
      target.set(a);
      TestBed.tick();
      a.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 4 }),
      );
      expect(drag.unthrottled().pointerId).toBe(4);
    });

    it('aborts and releases capture when the target swaps mid-gesture', () => {
      const { a, b, target, drag, changes } = signalTarget();
      target.set(a);
      TestBed.tick();
      a.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 4 }),
      );
      target.set(b);
      TestBed.tick();
      expect(drag.unthrottled()).toEqual({ ...IDLE_SHAPE, cancelled: true });
      expect(changes.at(-1)).toBe(true);
      expect(a.hasPointerCapture(4)).toBe(false);
    });

    it('aborts and releases capture when destroyed mid-gesture', () => {
      const { drag, el } = setup();
      el.dispatchEvent(
        pe('pointerdown', { clientX: 1, clientY: 1, pointerId: 6 }),
      );
      TestBed.resetTestingModule();
      expect(drag.unthrottled()).toEqual({ ...IDLE_SHAPE, cancelled: true });
      expect(el.hasPointerCapture(6)).toBe(false);
    });
  });
});
