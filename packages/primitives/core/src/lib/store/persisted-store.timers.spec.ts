import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  persist,
  providePersistedStoreOptions,
  type AsyncStore,
} from './persisted-store';
import { store } from './store';

type Spy = AsyncStore & {
  map: Map<string, unknown>;
  sets: unknown[];
  dels: number;
  gets: number;
};

function spyBackend(seed?: Record<string, unknown>): Spy {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  const b: Spy = {
    map,
    sets: [],
    dels: 0,
    gets: 0,
    get: async (k) => {
      b.gets++;
      await Promise.resolve();
      return map.get(k);
    },
    set: async (k, v) => {
      b.sets.push(v);
      await Promise.resolve();
      map.set(k, v);
    },
    del: async (k) => {
      b.dels++;
      await Promise.resolve();
      map.delete(k);
    },
  };
  return b;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const attach = <T extends object>(
  initial: T,
  opt: Parameters<typeof persist<T>>[1],
) =>
  TestBed.runInInjectionContext(() => {
    const s = store<T>(initial);
    return { s, handle: persist(s, opt) };
  });

describe('persist with fake timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a debounced write lands after writeDebounceMs, not before, with no flush', async () => {
    const b = spyBackend();
    const { s } = attach({ n: 0 }, { key: 'k', store: b, writeDebounceMs: 50 });
    await settle();
    s.n.set(1);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(49);
    expect(b.map.has('k')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(b.map.get('k')).toEqual({ n: 1 });
  });

  it.each([
    ['the 300 ms default', undefined, undefined, 300],
    ['a provider default', 120, undefined, 120],
    ['a per-call value over the provider', 120, 20, 20],
    ['zero', undefined, 0, 0],
  ])('debounces by %s', async (_, providerMs, callMs, expected) => {
    const b = spyBackend();
    if (providerMs !== undefined)
      TestBed.configureTestingModule({
        providers: [
          providePersistedStoreOptions({ writeDebounceMs: providerMs }),
        ],
      });
    const { s } = attach(
      { n: 0 },
      { key: 'k', store: b, writeDebounceMs: callMs },
    );
    await settle();
    s.n.set(1);
    TestBed.tick();
    if (expected > 0) {
      await vi.advanceTimersByTimeAsync(expected - 1);
      await settle();
      expect(b.sets).toHaveLength(0);
    }
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(b.sets).toEqual([{ n: 1 }]);
  });

  it('a burst inside the window coalesces to one write of the last value', async () => {
    const b = spyBackend();
    const { s } = attach({ n: 0 }, { key: 'k', store: b, writeDebounceMs: 50 });
    await settle();
    for (const n of [1, 2, 3]) {
      s.n.set(n);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(b.sets).toEqual([{ n: 3 }]);
  });

  it('clear() with a scheduled write leaves no entry after the window', async () => {
    const b = spyBackend({ k: { n: 5 } });
    const { s, handle } = attach(
      { n: 0 },
      { key: 'k', store: b, writeDebounceMs: 40 },
    );
    await settle();
    expect(s()).toEqual({ n: 5 });
    s.n.set(9);
    TestBed.tick();
    await handle.clear();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(s()).toEqual({ n: 0 });
    expect(b.map.has('k')).toBe(false);
    expect(b.sets).toHaveLength(0);
  });

  it('flush writes now and cancels the scheduled write', async () => {
    const b = spyBackend();
    const { s, handle } = attach(
      { n: 0 },
      { key: 'k', store: b, writeDebounceMs: 40 },
    );
    await settle();
    s.n.set(1);
    TestBed.tick();
    await handle.flush();
    expect(b.sets).toEqual([{ n: 1 }]);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(b.sets).toEqual([{ n: 1 }]);
  });

  it('teardown flushes the last value and an older scheduled write never lands', async () => {
    const b = spyBackend();
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    persist(s, { key: 'k', store: b, writeDebounceMs: 40, injector: env });
    await settle();
    s.n.set(1);
    TestBed.tick();
    s.n.set(2);
    env.destroy();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(b.map.get('k')).toEqual({ n: 2 });
    expect(b.sets).toEqual([{ n: 2 }]);
  });

  it('teardown removes the page-hide listeners', async () => {
    const b = spyBackend();
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    persist(s, { key: 'k', store: b, writeDebounceMs: 40, injector: env });
    await settle();
    env.destroy();
    await settle();
    s.n.set(7);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(b.sets).toHaveLength(0);
  });

  it.each([
    [
      'visibilitychange',
      () => document.dispatchEvent(new Event('visibilitychange')),
    ],
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
  ])('%s flushes without waiting for the debounce', async (_, fire) => {
    const b = spyBackend();
    const { s } = attach(
      { n: 0 },
      { key: 'k', store: b, writeDebounceMs: 1000 },
    );
    await settle();
    s.n.set(3);
    TestBed.tick();
    fire();
    await settle();
    expect(b.map.get('k')).toEqual({ n: 3 });
  });
});

describe('persist flush guards', () => {
  it('flush before hydration with no edits leaves the stored snapshot alone', async () => {
    const b = spyBackend({ k: { n: 5 } });
    const { handle } = attach({ n: 0 }, { key: 'k', store: b });
    await handle.flush();
    await settle();
    expect(b.sets).toHaveLength(0);
    const reopened = attach({ n: 0 }, { key: 'k', store: b });
    await settle();
    expect(reopened.s()).toEqual({ n: 5 });
  });

  it('flush after hydration does not write the hydrated snapshot back', async () => {
    const b = spyBackend({ k: { n: 5 } });
    const { handle } = attach({ n: 0 }, { key: 'k', store: b });
    await settle();
    await handle.flush();
    expect(b.sets).toHaveLength(0);
  });
});
