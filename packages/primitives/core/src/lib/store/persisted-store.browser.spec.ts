import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createStore, del, get, set } from 'idb-keyval';
import { persistedStore } from './persisted-store';

type Doc = { text: string; note: string };

const KEY = 'browser-persisted';
const raw = createStore('mm-persisted-browser', 'keyval');
const idb = {
  get: (k: string) => get(k, raw),
  set: (k: string, v: unknown) => set(k, v, raw),
  del: (k: string) => del(k, raw),
};

let app: EnvironmentInjector | null = null;

function boot() {
  app?.destroy();
  app = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
  return persistedStore<Doc>(
    { text: '', note: '' },
    {
      key: KEY,
      store: idb,
      version: 2,
      writeDebounceMs: 50,
      injector: app,
      migrate: (data, from) => {
        const old = data as Partial<Doc>;
        return { text: old.text ?? '', note: `migrated from v${from}` };
      },
    },
  );
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    TestBed.tick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never held');
}

async function hydrate(p: ReturnType<typeof boot>) {
  await until(() => p.hydrated());
  return p;
}

describe('persistedStore on a real IndexedDB', () => {
  beforeEach(() => idb.del(KEY));
  afterEach(async () => {
    app?.destroy();
    app = null;
    await idb.del(KEY);
  });

  it('persists a write to disk and restores it in a fresh app', async () => {
    const p = await hydrate(boot());
    p.store.text.set('hello disk');
    TestBed.tick();
    await p.flush();

    expect(await idb.get(KEY)).toEqual({
      __mmstack_pv: 2,
      data: { text: 'hello disk', note: '' },
    });

    const next = await hydrate(boot());
    expect(next.store.text()).toBe('hello disk');
  });

  it('migrates a seeded v1 record on boot and heals the disk to v2', async () => {
    await idb.set(KEY, { __mmstack_pv: 1, data: { text: 'from v1' } });

    const p = await hydrate(boot());
    expect([p.store.text(), p.store.note()]).toEqual([
      'from v1',
      'migrated from v1',
    ]);

    await until(async () => {
      const disk = (await idb.get(KEY)) as { __mmstack_pv: number };
      return disk.__mmstack_pv === 2;
    });
    expect(await idb.get(KEY)).toEqual({
      __mmstack_pv: 2,
      data: { text: 'from v1', note: 'migrated from v1' },
    });
  });

  it('clear() removes the entry from disk and resets the store', async () => {
    const p = await hydrate(boot());
    p.store.text.set('to be cleared');
    TestBed.tick();
    await p.flush();
    expect(await idb.get(KEY)).not.toBeUndefined();

    await p.clear();
    TestBed.tick();
    expect(p.store.text()).toBe('');
    expect(await idb.get(KEY)).toBeUndefined();
  });
});
