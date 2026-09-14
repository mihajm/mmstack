import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { debounced, debounce } from './debounced';

describe('debounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should debounce value updates via debounced()', () => {
    TestBed.runInInjectionContext(() => {
      const sig = debounced(0, { ms: 100 });
      expect(sig()).toBe(0);
      
      sig.set(1);
      expect(sig()).toBe(0); // Before time passes
      expect(sig.original()).toBe(1); // Original updates immediately
      
      vi.advanceTimersByTime(50);
      sig.set(2);
      expect(sig()).toBe(0); // Still 0 because timer was reset
      
      vi.advanceTimersByTime(100);
      expect(sig()).toBe(2); // Finally updates
    });
  });

  it('should debounce an existing signal via debounce()', () => {
    TestBed.runInInjectionContext(() => {
      const base = signal('a');
      const sig = debounce(base, { ms: 50 });
      
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
