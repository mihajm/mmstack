import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { throttled, throttle } from './throttled';

describe('throttled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should throttle value updates via throttled()', () => {
    TestBed.runInInjectionContext(() => {
      const sig = throttled(0, { ms: 100 });
      expect(sig()).toBe(0);
      
      sig.set(1);
      expect(sig()).toBe(0); // Before time passes
      expect(sig.original()).toBe(1); // Original updates immediately
      
      vi.advanceTimersByTime(50);
      sig.set(2);
      expect(sig()).toBe(0); // Still 0
      
      vi.advanceTimersByTime(50);
      expect(sig()).toBe(2); // Finally updates (100ms total)
    });
  });

  it('should throttle an existing signal via throttle()', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal('a');
      const sig = throttle(base, { ms: 50 });

      expect(sig()).toBe('a');

      sig.set('b');
      expect(base()).toBe('b');
      expect(sig()).toBe('a');

      vi.advanceTimersByTime(50);
      expect(sig()).toBe('b');

      sig.update(v => v + 'c');
      expect(base()).toBe('bc');
      expect(sig()).toBe('b');

      vi.advanceTimersByTime(50);
      expect(sig()).toBe('bc');
    });
  });

  it('leading: emits the first write immediately and holds further writes until cooldown', () => {
    TestBed.runInInjectionContext(() => {
      const sig = throttled(0, { ms: 100, leading: true, trailing: false });

      sig.set(1);
      expect(sig()).toBe(1); // leading-edge fire

      sig.set(2);
      sig.set(3);
      expect(sig()).toBe(1); // still in cooldown

      vi.advanceTimersByTime(100);
      expect(sig()).toBe(1); // no trailing fire when trailing: false

      sig.set(4);
      expect(sig()).toBe(4); // new burst — leading fires again
    });
  });

  it('leading + trailing: fires on both edges of a burst', () => {
    TestBed.runInInjectionContext(() => {
      const sig = throttled(0, { ms: 100, leading: true, trailing: true });

      sig.set(1);
      expect(sig()).toBe(1); // leading

      sig.set(2);
      expect(sig()).toBe(1); // held

      vi.advanceTimersByTime(100);
      expect(sig()).toBe(2); // trailing
    });
  });

  it('leading + trailing: a single write only fires once (leading), not twice', () => {
    TestBed.runInInjectionContext(() => {
      const sig = throttled(0, { ms: 100, leading: true, trailing: true });

      sig.set(1);
      expect(sig()).toBe(1);

      vi.advanceTimersByTime(100);
      // No further writes during the window — trailing must not double-fire.
      expect(sig()).toBe(1);
    });
  });
});
