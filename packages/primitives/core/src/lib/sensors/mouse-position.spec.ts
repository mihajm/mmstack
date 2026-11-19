import {
  createEnvironmentInjector,
  ElementRef,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mousePosition } from './mouse-position';

type Pt = { clientX: number; clientY: number; pageX: number; pageY: number };

function move(target: EventTarget, p: Partial<Pt>) {
  const e = new MouseEvent('mousemove', {
    clientX: p.clientX ?? 0,
    clientY: p.clientY ?? 0,
  });
  if (p.pageX !== undefined)
    Object.defineProperty(e, 'pageX', { value: p.pageX });
  if (p.pageY !== undefined)
    Object.defineProperty(e, 'pageY', { value: p.pageY });
  target.dispatchEvent(e);
}

// A MouseEvent built by another realm (a same-origin iframe) is not `instanceof MouseEvent` here.
function foreignMove(target: EventTarget, p: Pt) {
  const e = new Event('mousemove');
  for (const [k, v] of Object.entries(p))
    Object.defineProperty(e, k, { value: v });
  target.dispatchEvent(e);
}

function touchMove(target: EventTarget, p: Pt) {
  const e = new Event('touchmove');
  Object.defineProperty(e, 'touches', { value: [p] });
  target.dispatchEvent(e);
}

const childInjector = () =>
  createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));

describe('mousePosition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should track mouse movements with throttling', () => {
    TestBed.runInInjectionContext(() => {
      const pos = mousePosition({ throttle: 100 });

      expect(pos()).toEqual({ x: 0, y: 0 });

      // Simulate mousemove on window
      const mockEvent = new MouseEvent('mousemove', {
        clientX: 100,
        clientY: 200,
      });
      window.dispatchEvent(mockEvent);

      expect(pos.unthrottled()).toEqual({ x: 100, y: 200 });
      expect(pos()).toEqual({ x: 0, y: 0 }); // Since it's throttled and time hasn't passed

      vi.advanceTimersByTime(100);

      expect(pos()).toEqual({ x: 100, y: 200 }); // Now it should update
    });
  });

  it('should handle custom element target and page coordinate space', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const pos = mousePosition({
        target: el,
        coordinateSpace: 'page',
        throttle: 0,
      });

      expect(pos()).toEqual({ x: 0, y: 0 });

      const mockEvent = new MouseEvent('mousemove');
      Object.defineProperty(mockEvent, 'pageX', { value: 300 });
      Object.defineProperty(mockEvent, 'pageY', { value: 400 });

      el.dispatchEvent(mockEvent);

      vi.advanceTimersByTime(0);

      expect(pos()).toEqual({ x: 300, y: 400 });
    });
  });

  it('should attach to a signal target once it resolves (viewChild pattern)', () => {
    TestBed.runInInjectionContext(() => {
      const el = document.createElement('div');
      const target = signal<ElementRef<HTMLDivElement> | null>(null);
      const pos = mousePosition({ target, throttle: 0 });

      expect(pos()).toEqual({ x: 0, y: 0 });

      target.set(new ElementRef(el));
      TestBed.tick(); // run the attach effect

      const mockEvent = new MouseEvent('mousemove', { clientX: 7, clientY: 9 });
      el.dispatchEvent(mockEvent);
      vi.advanceTimersByTime(0);

      expect(pos()).toEqual({ x: 7, y: 9 });
    });
  });

  it('tracks the window with a 100ms default throttle when called bare', () => {
    const pos = TestBed.runInInjectionContext(() => mousePosition());
    expect(pos()).toEqual({ x: 0, y: 0 });
    move(window, { clientX: 5, clientY: 6 });
    expect(pos.unthrottled()).toEqual({ x: 5, y: 6 });
    vi.advanceTimersByTime(50);
    expect(pos()).toEqual({ x: 0, y: 0 });
    vi.advanceTimersByTime(50);
    expect(pos()).toEqual({ x: 5, y: 6 });
  });

  it('reports a horizontal-only and then a vertical-only move', () => {
    const pos = TestBed.runInInjectionContext(() =>
      mousePosition({ throttle: 0 }),
    );
    const seen: unknown[] = [];
    for (const [clientX, clientY] of [
      [10, 20],
      [30, 20],
      [30, 50],
    ]) {
      move(window, { clientX, clientY });
      seen.push(pos.unthrottled());
    }
    expect(seen).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 50 },
    ]);
  });

  it('ignores touch by default', () => {
    const pos = TestBed.runInInjectionContext(() => mousePosition());
    touchMove(window, { clientX: 1, clientY: 2, pageX: 3, pageY: 4 });
    expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });
  });

  it.each([
    ['client', { x: 1, y: 2 }],
    ['page', { x: 3, y: 4 }],
  ] as const)(
    'reports the first touch in %s space with touch: true',
    (space, want) => {
      const pos = TestBed.runInInjectionContext(() =>
        mousePosition({ touch: true, coordinateSpace: space }),
      );
      touchMove(window, { clientX: 1, clientY: 2, pageX: 3, pageY: 4 });
      expect(pos.unthrottled()).toEqual(want);
    },
  );

  it.each([
    ['client', { x: 1, y: 2 }],
    ['page', { x: 3, y: 4 }],
  ] as const)(
    'reports a mousemove from another realm in %s space',
    (space, want) => {
      const pos = TestBed.runInInjectionContext(() =>
        mousePosition({ coordinateSpace: space }),
      );
      foreignMove(window, { clientX: 1, clientY: 2, pageX: 3, pageY: 4 });
      expect(pos.unthrottled()).toEqual(want);
    },
  );

  it('stops listening to mouse and touch after destroy', () => {
    const injector = childInjector();
    const pos = mousePosition({ touch: true, injector });
    injector.destroy();
    move(window, { clientX: 5, clientY: 5 });
    touchMove(window, { clientX: 6, clientY: 6, pageX: 6, pageY: 6 });
    expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });
  });

  it('tolerates a null signal target and follows a target switch', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const target = signal<HTMLElement | null>(null);
    const pos = TestBed.runInInjectionContext(() => mousePosition({ target }));
    expect(() => TestBed.tick()).not.toThrow();
    expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });

    target.set(a);
    TestBed.tick();
    target.set(b);
    TestBed.tick();
    move(a, { clientX: 9, clientY: 9 });
    expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });
    move(b, { clientX: 4, clientY: 4 });
    expect(pos.unthrottled()).toEqual({ x: 4, y: 4 });
  });

  it('is a static origin on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const pos = TestBed.runInInjectionContext(() => mousePosition());
    move(window, { clientX: 5, clientY: 5 });
    expect(pos()).toEqual({ x: 0, y: 0 });
    expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });
  });

  describe('page space under scroll', () => {
    const setScroll = (x: number, y: number) => {
      Object.defineProperty(window, 'scrollX', {
        value: x,
        configurable: true,
      });
      Object.defineProperty(window, 'scrollY', {
        value: y,
        configurable: true,
      });
    };
    afterEach(() => {
      delete (window as { scrollX?: number }).scrollX;
      delete (window as { scrollY?: number }).scrollY;
    });

    it('moves the page position when the page scrolls under a still cursor', () => {
      setScroll(0, 0);
      const pos = TestBed.runInInjectionContext(() =>
        mousePosition({ coordinateSpace: 'page' }),
      );
      move(window, { clientX: 10, clientY: 20, pageX: 10, pageY: 20 });
      setScroll(5, 300);
      window.dispatchEvent(new Event('scroll'));
      expect(pos.unthrottled()).toEqual({ x: 15, y: 320 });
    });

    it('leaves client space alone on scroll', () => {
      const pos = TestBed.runInInjectionContext(() => mousePosition());
      move(window, { clientX: 10, clientY: 20 });
      setScroll(0, 300);
      window.dispatchEvent(new Event('scroll'));
      expect(pos.unthrottled()).toEqual({ x: 10, y: 20 });
    });

    it('does nothing on scroll before the first move', () => {
      const pos = TestBed.runInInjectionContext(() =>
        mousePosition({ coordinateSpace: 'page' }),
      );
      setScroll(0, 300);
      window.dispatchEvent(new Event('scroll'));
      expect(pos.unthrottled()).toEqual({ x: 0, y: 0 });
    });
  });
});
