import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { idle } from './idle';

const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('idle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips to true after the configured idle window', () => {
    TestBed.runInInjectionContext(() => {
      const sig = idle({ ms: 1000, events: ['keydown'] });

      expect(sig()).toBe(false);

      vi.advanceTimersByTime(999);
      expect(sig()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(sig()).toBe(true);
    });
  });

  it('resets to false when an activity event fires', () => {
    TestBed.runInInjectionContext(() => {
      const sig = idle({ ms: 1000, events: ['keydown'] });

      vi.advanceTimersByTime(1000);
      expect(sig()).toBe(true);

      window.dispatchEvent(new Event('keydown'));
      expect(sig()).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(sig()).toBe(true);
    });
  });

  it('defaults to a 60 second window with no options', () => {
    const sig = TestBed.runInInjectionContext(() => idle());
    expect(sig()).toBe(false);
    vi.advanceTimersByTime(59_999);
    expect(sig()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sig()).toBe(true);
  });

  it.each([
    ['mousemove'],
    ['keydown'],
    ['touchstart'],
    ['scroll'],
    ['visibilitychange'],
  ])('treats %s on window as default activity', (name) => {
    const sig = TestBed.runInInjectionContext(() => idle({ ms: 1000 }));
    vi.advanceTimersByTime(1000);
    expect(sig()).toBe(true);
    window.dispatchEvent(new Event(name));
    expect(sig()).toBe(false);
  });

  it('counts a scroll inside a scroll container as activity', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    try {
      const sig = TestBed.runInInjectionContext(() => idle({ ms: 1000 }));
      vi.advanceTimersByTime(900);
      panel.dispatchEvent(new Event('scroll', { bubbles: false }));
      vi.advanceTimersByTime(900);
      expect(sig()).toBe(false);
    } finally {
      panel.remove();
    }
  });

  it('replaces the defaults with custom events', () => {
    const sig = TestBed.runInInjectionContext(() =>
      idle({ ms: 1000, events: ['custom'] }),
    );
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event('keydown'));
    expect(sig()).toBe(true);
    window.dispatchEvent(new Event('custom'));
    expect(sig()).toBe(false);
  });

  it('restarts the window on activity while still active', () => {
    const sig = TestBed.runInInjectionContext(() =>
      idle({ ms: 1000, events: ['keydown'] }),
    );
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(100);
    expect(sig()).toBe(false);
    vi.advanceTimersByTime(899);
    expect(sig()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sig()).toBe(true);
  });

  it('stamps since with each transition and not with plain activity', () => {
    const sig = TestBed.runInInjectionContext(() =>
      idle({ ms: 1000, events: ['keydown'] }),
    );
    expect(sig.since().getTime()).toBe(T0.getTime());

    vi.advanceTimersByTime(500);
    window.dispatchEvent(new Event('keydown'));
    expect(sig.since().getTime()).toBe(T0.getTime());

    vi.advanceTimersByTime(1000);
    expect(sig()).toBe(true);
    expect(sig.since().getTime()).toBe(T0.getTime() + 1500);

    vi.advanceTimersByTime(250);
    window.dispatchEvent(new Event('keydown'));
    expect(sig()).toBe(false);
    expect(sig.since().getTime()).toBe(T0.getTime() + 1750);
  });

  it('never goes idle after destroy', () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector([], parent);
    const sig = idle({ ms: 1000, injector: child });
    vi.advanceTimersByTime(500);
    child.destroy();
    vi.advanceTimersByTime(5000);
    expect(sig()).toBe(false);
  });

  it('ignores activity after destroy', () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector([], parent);
    const sig = idle({ ms: 1000, injector: child, events: ['keydown'] });
    vi.advanceTimersByTime(1000);
    expect(sig()).toBe(true);
    child.destroy();
    window.dispatchEvent(new Event('keydown'));
    expect(sig()).toBe(true);
  });

  it('is a constant false with a fixed since on the server', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const sig = TestBed.runInInjectionContext(() => idle());
    const since = sig.since();
    expect(since).toBeInstanceOf(Date);
    vi.advanceTimersByTime(120_000);
    window.dispatchEvent(new Event('keydown'));
    expect(sig()).toBe(false);
    expect(sig.since()).toBe(since);
  });
});
