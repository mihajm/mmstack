import {
  computed,
  createEnvironmentInjector,
  DestroyRef,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { chunked } from './chunked';
import { providePaused } from './concurrent';
import { debounce, debounced } from './debounced';
import { throttle, throttled } from './throttled';

const childEnv = () =>
  createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));

describe('chunked contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("defaults to delay 'frame': nothing at 0 ms, the next chunk after a frame", () => {
    TestBed.runInInjectionContext(() => {
      const c = chunked(signal([1, 2, 3]), { chunkSize: 1 });
      TestBed.tick();
      vi.advanceTimersByTime(0);
      expect(c()).toEqual([1]);
      vi.advanceTimersByTime(16);
      expect(c()).toEqual([1, 2]);
    });
  });

  it('falls back to a 16 ms timeout without requestAnimationFrame', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    TestBed.runInInjectionContext(() => {
      const source = signal([1, 2, 3]);
      const c = chunked(source, { chunkSize: 1, delay: 'frame' });
      expect(() => TestBed.tick()).not.toThrow();
      vi.advanceTimersByTime(16);
      expect(c()).toEqual([1, 2]);
      source.set([9]);
      TestBed.tick();
      vi.advanceTimersByTime(50);
      expect(c()).toEqual([9]);
    });
  });

  it.each([
    ['frame', 16],
    [10, 10],
  ] as const)(
    'a source that shrinks mid-chunking never shows the stale list (delay %s)',
    (delay, step) => {
      TestBed.runInInjectionContext(() => {
        const source = signal([1, 2, 3]);
        const c = chunked(source, { chunkSize: 1, delay });
        TestBed.tick();
        source.set([9]);
        TestBed.tick();
        vi.advanceTimersByTime(step * 4);
        expect(c()).toEqual([9]);
      });
    },
  );

  it("a source that shrinks mid-chunking never shows the stale list (delay 'microtask')", async () => {
    await TestBed.runInInjectionContext(async () => {
      const source = signal([1, 2, 3]);
      const c = chunked(source, { chunkSize: 1, delay: 'microtask' });
      TestBed.tick();
      source.set([9]);
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
      expect(c()).toEqual([9]);
    });
  });

  it('stops growing once its injector is destroyed', () => {
    const env = childEnv();
    const c = chunked(signal([1, 2, 3]), {
      chunkSize: 1,
      delay: 10,
      injector: env,
    });
    TestBed.tick();
    env.destroy();
    vi.advanceTimersByTime(100);
    expect(c()).toEqual([1]);
  });

  it('does not pause under an ambient paused context unless asked', () => {
    TestBed.configureTestingModule({
      providers: [providePaused(signal(true))],
    });
    TestBed.runInInjectionContext(() => {
      const c = chunked(signal([1, 2, 3]), { chunkSize: 1, delay: 10 });
      TestBed.tick();
      vi.advanceTimersByTime(10);
      expect(c()).toEqual([1, 2]);
    });
  });

  it('settles once complete: no timers left, no recompute downstream', () => {
    TestBed.runInInjectionContext(() => {
      const c = chunked(signal([1, 2]), { chunkSize: 1, delay: 10 });
      let runs = 0;
      const reader = computed(() => {
        runs++;
        return c();
      });
      for (let i = 0; i < 3; i++) {
        TestBed.tick();
        vi.advanceTimersByTime(10);
        reader();
      }
      expect(c()).toEqual([1, 2]);
      const settled = runs;
      TestBed.tick();
      vi.advanceTimersByTime(100);
      TestBed.tick();
      reader();
      expect(runs).toBe(settled);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('works outside an injection context with an explicit injector', () => {
    const injector = TestBed.inject(Injector);
    const c = chunked(signal([1, 2]), { chunkSize: 1, delay: 10, injector });
    TestBed.tick();
    vi.advanceTimersByTime(10);
    expect(c()).toEqual([1, 2]);
  });
});

describe('debounce contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('works with no options (0 ms)', () => {
    TestBed.runInInjectionContext(() => {
      const d = debounced('a');
      d.set('b');
      vi.advanceTimersByTime(0);
      expect(d()).toBe('b');
      const w = debounce(signal(1));
      w.set(2);
      vi.advanceTimersByTime(0);
      expect(w()).toBe(2);
    });
  });

  it('lands ms after the last write, restarting on every write', () => {
    TestBed.runInInjectionContext(() => {
      const d = debounced('a', { ms: 100 });
      expect(d()).toBe('a');
      d.set('x');
      vi.advanceTimersByTime(50);
      d.set('b');
      vi.advanceTimersByTime(50);
      expect(d()).toBe('a');
      vi.advanceTimersByTime(50);
      expect(d()).toBe('b');
    });
  });

  it('an equal write while pending restarts the quiet period', () => {
    TestBed.runInInjectionContext(() => {
      const d = debounced('a', { ms: 100 });
      expect(d()).toBe('a');
      d.set('b');
      vi.advanceTimersByTime(60);
      d.set('b');
      vi.advanceTimersByTime(60);
      expect(d()).toBe('a');
      vi.advanceTimersByTime(40);
      expect(d()).toBe('b');
    });
  });

  it.each([
    ['the injected DestroyRef', false],
    ['an explicit destroyRef', true],
  ])('a pending value never lands after destroy (%s)', (_, explicit) => {
    const env = childEnv();
    const d = runInInjectionContext(env, () =>
      explicit
        ? debounce(signal('a'), { ms: 100, destroyRef: env.get(DestroyRef) })
        : debounce(signal('a')),
    );
    expect(d()).toBe('a');
    d.set('b');
    env.destroy();
    vi.advanceTimersByTime(200);
    expect(d()).toBe('a');
  });
});

describe('throttle contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('works with no options (trailing, 0 ms)', () => {
    TestBed.runInInjectionContext(() => {
      const t = throttled(0);
      t.set(1);
      vi.advanceTimersByTime(0);
      expect(t()).toBe(1);
      const w = throttle(signal(0));
      w.set(2);
      vi.advanceTimersByTime(0);
      expect(w()).toBe(2);
    });
  });

  it('a leading write after a quiet period shows at once and the window closes', () => {
    TestBed.runInInjectionContext(() => {
      const t = throttled(0, { ms: 100, leading: true });
      t.set(1);
      expect(t()).toBe(1);
      vi.advanceTimersByTime(150);
      expect(vi.getTimerCount()).toBe(0);
      t.set(2);
      expect(t()).toBe(2);
    });
  });

  it('an equal write does not open a window', () => {
    TestBed.runInInjectionContext(() => {
      const t = throttled(0, { ms: 100, leading: true });
      expect(t()).toBe(0);
      t.set(0);
      expect(t()).toBe(0);
      t.set(1);
      expect(t()).toBe(1);
    });
  });

  it('flush emits the latest value now', () => {
    TestBed.runInInjectionContext(() => {
      const t = throttled(0, { ms: 100 });
      expect(t()).toBe(0);
      t.set(1);
      expect(t()).toBe(0);
      t.flush();
      expect(t()).toBe(1);
    });
  });

  it('flush ends the window, so the next leading write shows at once and its own window holds', () => {
    TestBed.runInInjectionContext(() => {
      const t = throttled(0, { ms: 100, leading: true });
      expect(t()).toBe(0);
      t.set(1);
      expect(t()).toBe(1);
      vi.advanceTimersByTime(50);
      t.flush();
      t.set(2);
      expect(t()).toBe(2);
      vi.advanceTimersByTime(60);
      t.set(3);
      expect(t()).toBe(2);
      vi.advanceTimersByTime(40);
      expect(t()).toBe(3);
      vi.advanceTimersByTime(250);
      t.set(4);
      expect(t()).toBe(4);
    });
  });

  it('a pending trailing value never lands after destroy', () => {
    const env = childEnv();
    const t = runInInjectionContext(env, () => throttle(signal(0)));
    const t2 = runInInjectionContext(env, () =>
      throttle(signal(0), { ms: 100 }),
    );
    expect(t()).toBe(0);
    expect(t2()).toBe(0);
    t.set(1);
    t2.set(1);
    env.destroy();
    vi.advanceTimersByTime(200);
    expect(t()).toBe(0);
    expect(t2()).toBe(0);
  });
});
