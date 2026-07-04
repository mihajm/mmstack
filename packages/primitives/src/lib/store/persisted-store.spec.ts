import { TestBed } from '@angular/core/testing';
import {
  persist,
  persistedStore,
  providePersistedStoreOptions,
  type AsyncStore,
} from './persisted-store';
import { store } from './store';

/** In-memory AsyncStore with the idb-keyval shape; async by a microtask to mimic IndexedDB. */
function memoryBackend(seed?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  const backend: AsyncStore & { map: Map<string, unknown> } = {
    map,
    get: async (k) => {
      await Promise.resolve();
      return map.get(k);
    },
    set: async (k, v) => {
      await Promise.resolve();
      map.set(k, v);
    },
    del: async (k) => {
      await Promise.resolve();
      map.delete(k);
    },
  };
  return backend;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('persistedStore', () => {
  it('hydrates from the backend after boot (initial value shows until then)', async () => {
    const backend = memoryBackend({ prefs: { theme: 'dark', n: 2 } });
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ theme: 'light', n: 0 }, { key: 'prefs', store: backend }),
    );

    expect(p.store.theme()).toBe('light'); // async: not hydrated yet
    expect(p.hydrated()).toBe(false);

    await tick();
    expect(p.hydrated()).toBe(true);
    expect(p.store()).toEqual({ theme: 'dark', n: 2 });
  });

  it('persists changes to the backend (debounced, observable after flush)', async () => {
    const backend = memoryBackend();
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ count: 0 }, { key: 'c', store: backend, writeDebounceMs: 5 }),
    );
    await tick(); // hydrate (empty)

    p.store.count.set(5);
    await p.flush();

    expect(backend.map.get('c')).toEqual({ count: 5 });
  });

  it('a write during the boot window wins over a stale snapshot', async () => {
    const backend = memoryBackend({ doc: { title: 'stored' } });
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ title: 'initial' }, { key: 'doc', store: backend }),
    );

    p.store.title.set('user-wrote-first'); // before hydration resolves
    await tick();

    expect(p.store().title).toBe('user-wrote-first'); // stale disk did NOT clobber it
  });

  it('clear() removes the snapshot and resets to initial', async () => {
    const backend = memoryBackend({ x: { v: 9 } });
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ v: 0 }, { key: 'x', store: backend }),
    );
    await tick();
    expect(p.store().v).toBe(9);

    await p.clear();
    expect(p.store()).toEqual({ v: 0 });
    expect(backend.map.has('x')).toBe(false);
  });

  it('round-trips through the backend into a fresh store (survives a reload)', async () => {
    const backend = memoryBackend();
    const first = TestBed.runInInjectionContext(() =>
      persistedStore({ items: [] as string[] }, { key: 'r', store: backend, writeDebounceMs: 1 }),
    );
    await tick();
    first.store.items.set(['a', 'b']);
    await first.flush();

    // simulate a reload: a new store over the same backend + key
    const second = TestBed.runInInjectionContext(() =>
      persistedStore({ items: [] as string[] }, { key: 'r', store: backend }),
    );
    await tick();
    expect(second.store().items).toEqual(['a', 'b']);
  });

  it('uses a backend from providePersistedStoreOptions, with per-call override winning', async () => {
    const shared = memoryBackend({ k: { from: 'shared' } });
    const override = memoryBackend({ k: { from: 'override' } });
    TestBed.configureTestingModule({
      providers: [providePersistedStoreOptions({ store: shared })],
    });

    const usesShared = TestBed.runInInjectionContext(() =>
      persistedStore({ from: 'init' }, { key: 'k' }),
    );
    const usesOverride = TestBed.runInInjectionContext(() =>
      persistedStore({ from: 'init' }, { key: 'k', store: override }),
    );
    await tick();

    expect(usesShared.store().from).toBe('shared');
    expect(usesOverride.store().from).toBe('override');
  });

  it('with no backend and no provider: warns, runs in-memory, hydrated immediately', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const p = TestBed.runInInjectionContext(() =>
        persistedStore({ v: 1 }, { key: 'none' }),
      );
      expect(p.hydrated()).toBe(true);
      expect(() => p.store.v.set(2)).not.toThrow();
      expect(p.store().v).toBe(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('applies an optional serialize/deserialize pair', async () => {
    const backend = memoryBackend();
    const p = TestBed.runInInjectionContext(() =>
      persistedStore(
        { at: 0 },
        {
          key: 's',
          store: backend,
          writeDebounceMs: 1,
          serialize: (v) => JSON.stringify(v),
          deserialize: (raw) => JSON.parse(raw as string),
        },
      ),
    );
    await tick();
    p.store.at.set(42);
    await p.flush();

    expect(typeof backend.map.get('s')).toBe('string'); // serialized to a string
    expect(backend.map.get('s')).toBe('{"at":42}');
  });

  describe('versioning + migration', () => {
    it('writes a version envelope and migrates an older snapshot forward on boot', async () => {
      // v1 on disk: { name } → v2 shape: { first, last }
      const backend = memoryBackend({ u: { __mmstack_pv: 1, data: { name: 'Ada Lovelace' } } });
      const p = TestBed.runInInjectionContext(() =>
        persistedStore(
          { first: '', last: '' },
          {
            key: 'u',
            store: backend,
            version: 2,
            writeDebounceMs: 1,
            migrate: (data, from) => {
              expect(from).toBe(1);
              const [first, last] = (data as { name: string }).name.split(' ');
              return { first, last };
            },
          },
        ),
      );
      await tick();
      expect(p.store()).toEqual({ first: 'Ada', last: 'Lovelace' });

      // and it re-persists in the new (envelope, migrated) shape so disk heals
      await p.flush();
      expect(backend.map.get('u')).toEqual({
        __mmstack_pv: 2,
        data: { first: 'Ada', last: 'Lovelace' },
      });
    });

    it('awaits an async (lazy-loaded) migrate before hydration completes', async () => {
      const backend = memoryBackend({ k: { __mmstack_pv: 1, data: { v: 1 } } });
      const lazyMigrate = (data: unknown) =>
        // stand-in for `await import('./migrations/v2')`
        Promise.resolve().then(() => ({ v: (data as { v: number }).v * 10 }));
      const p = TestBed.runInInjectionContext(() =>
        persistedStore({ v: 0 }, { key: 'k', store: backend, version: 2, migrate: lazyMigrate }),
      );
      expect(p.hydrated()).toBe(false);
      await tick();
      expect(p.hydrated()).toBe(true);
      expect(p.store().v).toBe(10);
    });

    it('treats a legacy bare snapshot (no envelope) as version 0', async () => {
      const backend = memoryBackend({ leg: { count: 3 } }); // written before versioning existed
      const seen: number[] = [];
      const p = TestBed.runInInjectionContext(() =>
        persistedStore(
          { count: 0, doubled: 0 },
          {
            key: 'leg',
            store: backend,
            version: 1,
            migrate: (data, from) => {
              seen.push(from);
              const c = (data as { count: number }).count;
              return { count: c, doubled: c * 2 };
            },
          },
        ),
      );
      await tick();
      expect(seen).toEqual([0]);
      expect(p.store()).toEqual({ count: 3, doubled: 6 });
    });

    it('adopts a matching-version snapshot without calling migrate', async () => {
      const backend = memoryBackend({ m: { __mmstack_pv: 3, data: { ok: true } } });
      const migrate = vi.fn((d: unknown) => d as { ok: boolean });
      const p = TestBed.runInInjectionContext(() =>
        persistedStore({ ok: false }, { key: 'm', store: backend, version: 3, migrate }),
      );
      await tick();
      expect(p.store().ok).toBe(true);
      expect(migrate).not.toHaveBeenCalled();
    });

    it('leaves a newer-than-this-build snapshot untouched and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const backend = memoryBackend({ n: { __mmstack_pv: 5, data: { shape: 'future' } } });
        const p = TestBed.runInInjectionContext(() =>
          persistedStore({ shape: 'initial' }, { key: 'n', store: backend, version: 2 }),
        );
        await tick();
        expect(p.store().shape).toBe('initial'); // did NOT adopt the newer snapshot
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('does not write a freshly hydrated snapshot straight back to the backend', async () => {
    const backend = memoryBackend({ w: { v: 1 } });
    let sets = 0;
    const origSet = backend.set.bind(backend);
    backend.set = (k, val) => {
      sets++;
      return origSet(k, val);
    };
    const p = TestBed.runInInjectionContext(() =>
      persistedStore({ v: 0 }, { key: 'w', store: backend, writeDebounceMs: 1 }),
    );
    await tick();
    await tick(); // let any debounced write fire
    expect(p.store().v).toBe(1); // hydrated
    expect(sets).toBe(0); // identical data must not be re-persisted on boot

    p.store.v.set(2); // a real edit still persists
    await p.flush();
    expect(sets).toBe(1);
    expect(backend.map.get('w')).toEqual({ v: 2 });
  });

  it('idb-keyval and a Dexie-style adapter both satisfy AsyncStore (type + runtime)', async () => {
    // idb-keyval shape: get/set/del as free functions (extra trailing arg is compatible)
    const kv = memoryBackend();
    const idbLike: AsyncStore = {
      get: (k) => kv.get(k),
      set: (k, v) => kv.set(k, v),
      del: (k) => kv.del(k),
    };
    // Dexie-table shape wrapped into the interface
    const table = new Map<string, { key: string; value: unknown }>();
    const dexieLike: AsyncStore = {
      get: (k) => Promise.resolve(table.get(k)?.value),
      set: (k, v) => {
        table.set(k, { key: k, value: v });
        return Promise.resolve();
      },
      del: (k) => {
        table.delete(k);
        return Promise.resolve();
      },
    };

    for (const backend of [idbLike, dexieLike]) {
      const p = TestBed.runInInjectionContext(() =>
        persistedStore({ ok: false }, { key: 'a', store: backend, writeDebounceMs: 1 }),
      );
      await tick();
      p.store.ok.set(true);
      await p.flush();
      const reopened = TestBed.runInInjectionContext(() =>
        persistedStore({ ok: false }, { key: 'a', store: backend }),
      );
      await tick();
      expect(reopened.store().ok).toBe(true);
    }
  });
});

describe('persist (composable reader on an existing store)', () => {
  const attach = <T extends object>(
    initial: T,
    opt: Parameters<typeof persist<T>>[1],
  ) =>
    TestBed.runInInjectionContext(() => {
      const s = store<T>(initial);
      const handle = persist(s, opt);
      return { s, handle };
    });

  it('returns a handle (no .store) and flips hydrated after the backend answers', async () => {
    const backend = memoryBackend();
    const { handle } = attach({ x: 0 }, { key: 'h', store: backend });
    expect('store' in handle).toBe(false);
    expect(handle.hydrated()).toBe(false);
    await tick();
    expect(handle.hydrated()).toBe(true);
  });

  it('persists writes to an existing store and restores them onto a fresh one', async () => {
    const backend = memoryBackend();
    const { s, handle } = attach(
      { n: 0 },
      { key: 'e', store: backend, writeDebounceMs: 1 },
    );
    await tick();
    s.n.set(7);
    await handle.flush();
    expect(backend.map.get('e')).toEqual({ n: 7 });

    const reopened = attach({ n: 0 }, { key: 'e', store: backend });
    await tick();
    expect(reopened.s()).toEqual({ n: 7 });
  });

  it('persists a change it did not originate (a second reader applying to the store)', async () => {
    const backend = memoryBackend();
    const { s, handle } = attach(
      { n: 0 },
      { key: 'g', store: backend, writeDebounceMs: 1 },
    );
    await tick();
    // stand-in for another reader (e.g. mesh) applying a remote op to the same store
    s.n.set(55);
    await handle.flush();
    expect(backend.map.get('g')).toEqual({ n: 55 });
  });

  it('two persist readers on ONE store each persist to their own backend, no interference', async () => {
    const b1 = memoryBackend();
    const b2 = memoryBackend();
    const built = TestBed.runInInjectionContext(() => {
      const s = store<{ n: number }>({ n: 0 });
      const h1 = persist(s, { key: 'k', store: b1, writeDebounceMs: 1 });
      const h2 = persist(s, { key: 'k', store: b2, writeDebounceMs: 1 });
      return { s, h1, h2 };
    });
    await tick();
    built.s.n.set(9);
    await built.h1.flush();
    await built.h2.flush();
    expect(b1.map.get('k')).toEqual({ n: 9 });
    expect(b2.map.get('k')).toEqual({ n: 9 });
  });

  // --- mud ---

  it('MUD: a burst of rapid writes coalesces to the last value (one write on flush)', async () => {
    const backend = memoryBackend();
    let sets = 0;
    const origSet = backend.set.bind(backend);
    backend.set = (k, v) => {
      sets++;
      return origSet(k, v);
    };
    const { s, handle } = attach(
      { n: 0 },
      { key: 'burst', store: backend, writeDebounceMs: 30 },
    );
    await tick();
    s.n.set(1);
    s.n.set(2);
    s.n.set(3);
    await handle.flush();
    expect(backend.map.get('burst')).toEqual({ n: 3 });
    expect(sets).toBe(1); // the debounce collapsed the burst; flush wrote once
  });

  it('MUD: clear() during a pending debounced write does not resurrect the entry', async () => {
    const backend = memoryBackend({ c: { n: 5 } });
    const { s, handle } = attach(
      { n: 0 },
      { key: 'c', store: backend, writeDebounceMs: 40 },
    );
    await tick();
    expect(s()).toEqual({ n: 5 }); // hydrated from disk

    s.n.set(9); // schedules a debounced write ~40ms out
    await handle.clear(); // must cancel it, reset the store, and delete the entry
    expect(s()).toEqual({ n: 0 });
    expect(backend.map.has('c')).toBe(false);

    await new Promise((r) => setTimeout(r, 60)); // past the debounce window
    expect(backend.map.has('c')).toBe(false); // the cancelled write never landed
  });

  it('MUD: a write during the async boot window wins over a stale snapshot', async () => {
    const backend = memoryBackend({ b: { n: 100 } });
    const { s } = attach({ n: 0 }, { key: 'b', store: backend });
    s.n.set(42); // before hydration resolves
    await tick();
    expect(s().n).toBe(42); // stale disk did NOT clobber the boot write
  });

  it('MUD: a backend that throws on set/get is swallowed; the store stays usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const angry: AsyncStore = {
        get: () => Promise.reject(new Error('disk read boom')),
        set: () => Promise.reject(new Error('disk write boom')),
        del: () => Promise.resolve(),
      };
      const { s, handle } = attach(
        { n: 0 },
        { key: 'x', store: angry, writeDebounceMs: 1 },
      );
      await tick(); // hydrate rejects → swallowed, hydrated still flips
      expect(handle.hydrated()).toBe(true);
      s.n.set(3);
      await handle.flush(); // write rejects → swallowed, no throw
      expect(s().n).toBe(3); // the store is unaffected by the dead backend
    } finally {
      warn.mockRestore();
    }
  });
});
