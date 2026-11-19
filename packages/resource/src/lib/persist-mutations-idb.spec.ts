import { EnvironmentInjector, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { injectPendingMutations } from './util';
import {
  MUTATION_PERSISTENCE_DB,
  MUTATION_SYNC,
} from './util/persist-mutations';
import {
  configureRoot,
  createServer,
  persistedResource,
  type Server,
  settle,
} from './util/testing/persist-harness';

describe('mutation persistence defaults', () => {
  let server: Server;
  const root = () => TestBed.inject(EnvironmentInjector);
  const diskRows = async () =>
    (await TestBed.inject(MUTATION_PERSISTENCE_DB).then((db) => db.getAll()))
      .length;
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      await settle(1);
      if (await check()) return;
    }
    throw new Error('condition never held');
  }

  beforeEach(() => {
    server = createServer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('on IndexedDB', () => {
    beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));

    it('a stash made offline is on disk and replays in the next app', async () => {
      const online = configureRoot({ server, persistence: [] });
      online.set(false);
      persistedResource(root(), { queue: true }).mutate({ n: 1 });
      await until(async () => (await diskRows()) === 1);

      TestBed.resetTestingModule();
      configureRoot({ server, persistence: [] });
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );
      persistedResource(root(), { queue: true });
      await until(async () => server.calls.length === 1);
      await until(async () => (await diskRows()) === 0);

      expect(server.bodies()).toEqual([{ n: 1 }]);
      expect(pending.count()).toBe(0);
    });

    it('rows past their ttl never come back from disk', async () => {
      const online = configureRoot({ server, persistence: [] });
      online.set(false);
      persistedResource(root(), {
        persist: { key: 'update', ttl: 1000 },
      }).mutate({ n: 1 });
      await until(async () => (await diskRows()) === 1);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      TestBed.resetTestingModule();
      configureRoot({ server, persistence: [] });
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );
      persistedResource(root());
      await settle();
      expect([server.calls.length, pending.count()]).toEqual([0, 0]);
    });
  });

  it('on the server a persisted mutation still runs, with nothing kept', async () => {
    configureRoot({
      server,
      persistence: [],
      extra: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const pending = TestBed.runInInjectionContext(() =>
      injectPendingMutations(),
    );
    persistedResource(root()).mutate({ n: 1 });
    expect(pending.count()).toBe(1);
    await settle();
    expect([server.calls.length, pending.count()]).toEqual([1, 0]);
  });

  describe('cross-tab channel', () => {
    const channelOn = (platform: string) => {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: platform }],
      });
      return TestBed.inject(MUTATION_SYNC);
    };

    it('is a BroadcastChannel in the browser', () => {
      class FakeChannel {
        onmessage = null;
        constructor(readonly name: string) {}
        postMessage() {
          /* noop */
        }
        close() {
          /* noop */
        }
      }
      vi.stubGlobal('BroadcastChannel', FakeChannel);
      expect(channelOn('browser')).toBeInstanceOf(FakeChannel);
    });

    it('is absent on the server, so requests in one process never share stashes', () => {
      expect(channelOn('server')).toBeNull();
    });

    it('is absent where BroadcastChannel does not exist', () => {
      vi.stubGlobal('BroadcastChannel', undefined);
      expect(() => channelOn('browser')).not.toThrow();
      expect(TestBed.inject(MUTATION_SYNC)).toBeNull();
    });
  });
});
