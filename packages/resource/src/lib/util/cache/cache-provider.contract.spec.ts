import { HttpHeaders, HttpResponse } from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  type Provider,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import {
  injectCacheStats,
  injectQueryCache,
  provideMockQueryCache,
  provideQueryCache,
} from './cache';

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const res = (body: unknown) =>
  new HttpResponse({ body, status: 200, headers: new HttpHeaders({ a: '1' }) });

function env(providers: Provider[]) {
  return createEnvironmentInjector(
    providers,
    TestBed.inject(EnvironmentInjector),
  );
}

describe('provideQueryCache wiring', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('destroying the providing injector stops the sweep', () => {
    vi.useFakeTimers();
    const injector = env([
      provideQueryCache({ cleanup: { checkInterval: 1000 } }),
    ]);
    injectQueryCache(injector);
    expect(vi.getTimerCount()).toBe(1);
    injector.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provideMockQueryCache runs no sweep interval', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideMockQueryCache()] });
    TestBed.runInInjectionContext(() => injectQueryCache());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('injectCacheStats follows the injected cache', () => {
    TestBed.configureTestingModule({ providers: [provideMockQueryCache()] });
    const stats = TestBed.runInInjectionContext(() => injectCacheStats());
    TestBed.runInInjectionContext(() => injectQueryCache().store('k', res(1)));
    expect(stats().size).toBe(1);
  });

  async function syncs(a: Provider[], b: Provider[]) {
    const ia = env(a);
    const ib = env(b);
    const receiver = injectQueryCache(ib);
    injectQueryCache(ia).store('k', res(1));
    await wait();
    const got = receiver.getUntracked('k');
    ia.destroy();
    ib.destroy();
    return got;
  }

  it('syncTabs is opt-in and off on the server', async () => {
    const on = provideQueryCache({ syncTabs: true, persist: false });
    expect((await syncs([on], [on]))!.value.body).toBe(1);
    const off = provideQueryCache({ persist: false });
    expect(await syncs([off], [off])).toBeNull();
    const server = { provide: PLATFORM_ID, useValue: 'server' };
    expect(await syncs([on, server], [on, server])).toBeNull();
  });

  it('caches on different versions do not exchange messages', async () => {
    expect(
      await syncs(
        [provideQueryCache({ syncTabs: true, persist: false, version: 1 })],
        [provideQueryCache({ syncTabs: true, persist: false, version: 2 })],
      ),
    ).toBeNull();
  });

  it('custom serialize and deserialize are used for sync', async () => {
    const serialize = vi.fn((v: HttpResponse<unknown>) => ({ b: v.body }));
    const deserialize = vi.fn(
      (v: unknown) => new HttpResponse({ body: (v as { b: unknown }).b }),
    );
    const p = provideQueryCache({
      syncTabs: true,
      persist: false,
      serialize,
      deserialize,
    });
    expect((await syncs([p], [p]))!.value.body).toBe(1);
    expect(serialize).toHaveBeenCalled();
    expect(deserialize).toHaveBeenCalled();
  });

  it('persist: false and the server never open IndexedDB', () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal('indexedDB', { open });
    injectQueryCache(env([provideQueryCache({ persist: false })]));
    injectQueryCache(
      env([provideQueryCache(), { provide: PLATFORM_ID, useValue: 'server' }]),
    );
    expect(open).not.toHaveBeenCalled();
    injectQueryCache(env([provideQueryCache()]));
    expect(open).toHaveBeenCalled();
  });
});

describe('provideQueryCache persistence (IndexedDB)', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  const reload = async (p: Provider) => {
    const injector = env([p]);
    const cache = injectQueryCache(injector);
    await wait(30);
    return { cache, injector };
  };

  it('a persisted response comes back after a reload as an HttpResponse', async () => {
    const first = await reload(provideQueryCache());
    first.cache.store('k', res({ n: 1 }), 60_000, 120_000, true);
    first.cache.store('mem', res(2), 60_000, 120_000, false);
    await wait(30);
    first.injector.destroy();

    const second = await reload(provideQueryCache());
    const entry = second.cache.getUntracked('k')!;
    expect(entry.value).toBeInstanceOf(HttpResponse);
    expect(entry.value.body).toEqual({ n: 1 });
    expect(entry.value.headers.get('a')).toBe('1');
    expect(second.cache.getUntracked('mem')).toBeNull();
  });

  it('a row the deserializer rejects is skipped without breaking hydration', async () => {
    const first = await reload(provideQueryCache());
    first.cache.store('bad', res('bad'), 60_000, 120_000, true);
    first.cache.store('good', res('good'), 60_000, 120_000, true);
    await wait(30);
    const second = await reload(
      provideQueryCache({
        deserialize: (v) => {
          const body = (v as { body: unknown }).body;
          return body === 'bad' ? null : new HttpResponse({ body });
        },
      }),
    );
    expect(second.cache.getUntracked('bad')).toBeNull();
    expect(second.cache.getUntracked('good')!.value.body).toBe('good');
  });

  it('bumping the version drops old rows, and the new version persists', async () => {
    const v1 = await reload(provideQueryCache({ version: 1 }));
    v1.cache.store('old', res(1), 60_000, 120_000, true);
    await wait(30);
    v1.injector.destroy();

    const v2 = await reload(provideQueryCache({ version: 2 }));
    expect(v2.cache.getUntracked('old')).toBeNull();
    v2.cache.store('new', res(2), 60_000, 120_000, true);
    await wait(30);
    const again = await reload(provideQueryCache({ version: 2 }));
    expect(again.cache.getUntracked('new')!.value.body).toBe(2);
  });

  it('clear() before hydration removes the persisted rows', async () => {
    const first = await reload(provideQueryCache());
    first.cache.store('a', res(1), 60_000, 120_000, true);
    await wait(30);
    const second = injectQueryCache(env([provideQueryCache()]));
    second.clear();
    await wait(30);
    expect(second.stats().size).toBe(0);
    const third = await reload(provideQueryCache());
    expect(third.cache.stats().size).toBe(0);
  });
});
