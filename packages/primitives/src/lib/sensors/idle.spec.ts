import { TestBed } from '@angular/core/testing';
import { idle } from './idle';

describe('idle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips to true after the configured idle window', () => {
    TestBed.runInInjectionContext(() => {
      const sig = idle({ ms: 1000, events: ['keydown'] });

      expect(sig()).toBe(false);

      vi.advanceTimersByTime(1000);
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
});
