import {
  createEnvironmentInjector,
  DestroyRef,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
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

  const child = () =>
    createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));

  class CountingDestroyRef implements DestroyRef {
    readonly callbacks = new Set<() => void>();
    destroyed = false;
    onDestroy(cb: () => void) {
      this.callbacks.add(cb);
      return () => this.callbacks.delete(cb);
    }
    destroy() {
      this.destroyed = true;
      for (const cb of [...this.callbacks]) cb();
    }
  }

  it('without a timeout never rejects on its own', async () => {
    const sig = signal(0);
    const p = TestBed.runInInjectionContext(() => until(sig, (v) => v > 0));
    vi.advanceTimersByTime(1000);
    sig.set(3);
    TestBed.tick();
    expect(await p).toBe(3);
  });

  it('outside an injection context without an injector rejects with a diagnostic', async () => {
    const p = until(signal(0), (v) => v > 0);
    await expect(p).rejects.toThrow(/injector/);
  });

  it('rejects when the ambient context is destroyed', async () => {
    const env = child();
    const ps = [0, 1, 2].map(() =>
      runInInjectionContext(env, () => until(signal(0), (v) => v > 0)),
    );
    env.destroy();
    for (const p of ps) await expect(p).rejects.toThrow(/destruction/);
  });

  it('an explicit destroyRef wins over the ambient one', async () => {
    const other = child();
    const p = TestBed.runInInjectionContext(() =>
      until(signal(0), (v) => v > 0, { destroyRef: other.get(DestroyRef) }),
    );
    other.destroy();
    await expect(p).rejects.toThrow(/destruction/);
  });

  it('releases its destroy callback once it settles', async () => {
    const ref = new CountingDestroyRef();
    const sig = signal(0);
    const resolved = TestBed.runInInjectionContext(() =>
      until(sig, (v) => v > 0, { destroyRef: ref }),
    );
    expect(ref.callbacks.size).toBe(1);
    sig.set(1);
    TestBed.tick();
    await resolved;
    expect(ref.callbacks.size).toBe(0);

    const immediate = until(signal(1), (v) => v > 0, { destroyRef: ref });
    await immediate;
    expect(ref.callbacks.size).toBe(0);

    const timedOut = TestBed.runInInjectionContext(() =>
      until(signal(0), (v) => v > 0, { destroyRef: ref, timeout: 10 }),
    );
    vi.advanceTimersByTime(10);
    await expect(timedOut).rejects.toThrow();
    expect(ref.callbacks.size).toBe(0);
  });

  it('a destroy during settle still rejects every pending call', async () => {
    const ref = new CountingDestroyRef();
    const ps = [0, 1, 2].map(() =>
      TestBed.runInInjectionContext(() =>
        until(signal(0), (v) => v > 0, { destroyRef: ref }),
      ),
    );
    ref.destroy();
    for (const p of ps) await expect(p).rejects.toThrow(/destruction/);
  });
});
