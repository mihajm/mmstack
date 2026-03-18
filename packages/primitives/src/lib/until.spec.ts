import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { until } from './until';

describe('until', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve immediately if predicate is already true', async () => {
    await TestBed.runInInjectionContext(async () => {
      const sig = signal(5);

      const res = await until(sig, (v) => v > 0);

      expect(res).toBe(5);
    });
  });

  it('should resolve when predicate becomes true', async () => {
    const resPromise = TestBed.runInInjectionContext(() => {
      const sig = signal(0);

      const p = until(sig, (v) => v > 0);

      sig.set(5);
      TestBed.tick();

      return p;
    });

    expect(await resPromise).toBe(5);
  });

  it('should reject on timeout', async () => {
    const p = TestBed.runInInjectionContext(() => {
      const sig = signal(0);

      // Don't await directly, advance timers first
      const promise = until(sig, (v) => v > 0, { timeout: 100 });
      return promise;
    });

    vi.advanceTimersByTime(100);

    await expect(p).rejects.toThrow('Timeout after 100ms');
  });
});
