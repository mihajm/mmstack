import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { persist, persistedStore, type AsyncStore } from './persisted-store';
import { store } from './store';

type Spy = AsyncStore & { map: Map<string, unknown>; calls: string[] };

/** Backend whose `set` waits for a manual release, like an encrypting decorator over IndexedDB. */
function slowBackend(seed?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  const pending: Array<() => void> = [];
  const b: Spy & { release(i?: number): void; pending: typeof pending } = {
    map,
    calls: [],
    pending,
    get: async (k) => {
      await Promise.resolve();
      return map.get(k);
    },
    set: (k, v) => {
      b.calls.push(`set ${JSON.stringify(v)}`);
      return new Promise<void>((resolve) =>
        pending.push(() => {
          map.set(k, v);
          resolve();
        }),
      );
    },
    del: async (k) => {
      b.calls.push('del');
      map.delete(k);
    },
    release: (i = 0) => pending.splice(i, 1)[0]?.(),
  };
  return b;
}

function spyBackend(seed?: Record<string, unknown>): Spy {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  const b: Spy = {
    map,
    calls: [],
    get: async (k) => {
      b.calls.push('get');
      await Promise.resolve();
      return map.get(k);
    },
    set: async (k, v) => {
      b.calls.push('set');
      await Promise.resolve();
      map.set(k, v);
    },
    del: async (k) => {
      b.calls.push('del');
      await Promise.resolve();
      map.delete(k);
    },
  };
  return b;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('persist reported edge cases', () => {
  it('setting the store back to its attach-time object is persisted', async () => {
    const DEFAULTS = { theme: 'light' };
    const b = spyBackend({ prefs: { theme: 'dark' } });
    const p = TestBed.runInInjectionContext(() =>
      persistedStore(DEFAULTS, { key: 'prefs', store: b }),
    );
    await settle();
    expect(p.store()).toEqual({ theme: 'dark' });
    p.store.set(DEFAULTS);
    await p.flush();
    expect(b.map.get('prefs')).toEqual({ theme: 'light' });
  });

  it('a boot-window write survives teardown before hydration lands', async () => {
    const b = slowBackend({ k: { n: 100 } });
    let releaseGet!: () => void;
    b.get = (k) =>
      new Promise((resolve) => {
        releaseGet = () => resolve(b.map.get(k));
      });
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const s = TestBed.runInInjectionContext(() => store({ n: 0 }));
    persist(s, { key: 'k', store: b, injector: env });
    s.n.set(42);
    env.destroy();
    await settle();
    b.release();
    releaseGet();
    await settle();
    expect(b.map.get('k')).toEqual({ n: 42 });
    expect(s()).toEqual({ n: 42 });
  });

  it('clear() after a slow write leaves no entry', async () => {
    const b = slowBackend();
    const { s, handle } = TestBed.runInInjectionContext(() => {
      const st = store({ n: 0 });
      return { s: st, handle: persist(st, { key: 'k', store: b }) };
    });
    await settle();
    s.n.set(1);
    const flushed = handle.flush();
    const cleared = handle.clear();
    await settle();
    b.release();
    await flushed;
    await cleared;
    await settle();
    expect(b.map.has('k')).toBe(false);
    expect(b.calls).toEqual(['set {"n":1}', 'del']);
  });

  it('overlapping writes land in the order they were made', async () => {
    const b = slowBackend();
    const { s, handle } = TestBed.runInInjectionContext(() => {
      const st = store({ n: 0 });
      return { s: st, handle: persist(st, { key: 'k', store: b }) };
    });
    await settle();
    s.n.set(1);
    const first = handle.flush();
    s.n.set(2);
    const second = handle.flush();
    await settle();
    // the backend finishes the newest call first whenever two are in flight at once
    while (b.pending.length) {
      b.release(b.pending.length - 1);
      await settle();
    }
    await first;
    await second;
    expect(b.map.get('k')).toEqual({ n: 2 });
    expect(b.calls).toEqual(['set {"n":1}', 'set {"n":2}']);
  });
});

describe('persist on the server and without a backend', () => {
  it('on the server it never touches the backend and is hydrated at once', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const b = spyBackend({ k: { n: 9 } });
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ n: 0 }, { key: 'k', store: b }),
    );
    expect(p.hydrated()).toBe(true);
    p.store.n.set(1);
    TestBed.tick();
    await p.flush();
    await settle();
    expect(p.store()).toEqual({ n: 1 });
    expect(b.calls).toEqual([]);
  });

  it('without a backend flush resolves and clear resets to the attach-time value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = TestBed.runInInjectionContext(() =>
        persistedStore({ v: 1 }, { key: 'none' }),
      );
      p.store.v.set(2);
      await expect(p.flush()).resolves.toBeUndefined();
      await p.clear();
      expect(p.store()).toEqual({ v: 1 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('persist read side', () => {
  it('a backend that answers null for a missing key keeps the initial value', async () => {
    const b = spyBackend();
    b.get = async () => null;
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ n: 1 }, { key: 'k', store: b }),
    );
    await settle();
    expect(p.hydrated()).toBe(true);
    expect(p.store()).toEqual({ n: 1 });
    p.store.n.set(2);
    expect(p.store.n()).toBe(2);
  });

  it('a string snapshot round-trips into a fresh store', async () => {
    const b = spyBackend();
    const opt = {
      key: 's',
      store: b,
      serialize: (v: { at: number }) => JSON.stringify(v),
      deserialize: (raw: unknown) => JSON.parse(raw as string),
    };
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ at: 0 }, opt),
    );
    await settle();
    p.store.at.set(42);
    await p.flush();
    const reopened = TestBed.runInInjectionContext(() =>
      persistedStore({ at: 0 }, opt),
    );
    await settle();
    expect(reopened.store()).toEqual({ at: 42 });
  });

  it('a write made while an async migrate runs wins over the migrated snapshot', async () => {
    const b = spyBackend({ k: { __mmstack_pv: 1, data: { n: 1 } } });
    let finish!: (v: { n: number }) => void;
    const p = TestBed.runInInjectionContext(() =>
      persistedStore(
        { n: 0 },
        {
          key: 'k',
          store: b,
          version: 2,
          migrate: () => new Promise<{ n: number }>((r) => (finish = r)),
        },
      ),
    );
    await settle();
    p.store.n.set(7);
    finish({ n: 100 });
    await settle();
    expect(p.store()).toEqual({ n: 7 });
  });

  it('works outside an injection context with an explicit injector', async () => {
    const injector = TestBed.inject(Injector);
    const b = spyBackend({ k: { n: 3 } });
    const p = persistedStore({ n: 0 }, { key: 'k', store: b, injector });
    const s = store({ n: 0 }, { injector });
    const h = persist(s, { key: 'k', store: b, injector });
    await settle();
    expect(p.store()).toEqual({ n: 3 });
    expect(s()).toEqual({ n: 3 });
    s.n.set(4);
    await h.flush();
    expect(b.map.get('k')).toEqual({ n: 4 });
  });
});
