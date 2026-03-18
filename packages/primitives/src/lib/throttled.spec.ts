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
});
