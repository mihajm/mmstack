import { runInInjectionContext } from '@angular/core';
import { injectPendingMutations, provideMockMutationPersistence } from './util';
import { MUTATION_PERSISTENCE_DB } from './util/persist-mutations';
import {
  createFakeChannelHub,
  createFakeLocks,
  createRejectingLocks,
} from './util/testing/fake-locks';
import {
  configureRoot,
  createServer,
  makeTab,
  persistedResource,
  type Server,
  settle,
  type SharedInfra,
  stashed,
  type Tab,
} from './util/testing/persist-harness';

type Seed = { key?: string; n: number; session?: string };

describe('mutation persistence across tabs', () => {
  let server: Server;

  function shared(
    rows: Seed[] = [],
    opts: { sync?: boolean; locks?: LockManager | null } = {},
  ): SharedInfra {
    configureRoot({ server });
    return {
      db: provideMockMutationPersistence({
        rows: rows.map((r, i) => ({
          key: r.key ?? 'update',
          raw: stashed({ n: r.n }),
          created: Date.now() - 1000 * (rows.length - i),
          session: r.session,
        })),
      }),
      locks: opts.locks === undefined ? createFakeLocks() : opts.locks,
      hub: opts.sync === false ? undefined : createFakeChannelHub(),
    };
  }
  const pendingOf = (tab: Tab) =>
    runInInjectionContext(tab.injector, () => injectPendingMutations());
  const offline = (tab: Tab) => {
    tab.online.set(false);
    return tab;
  };

  beforeEach(() => {
    server = createServer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('lock edge cases', () => {
    it('a registry torn down right after its session lock is granted releases it', async () => {
      const infra = shared([], { sync: false });
      const tabA = makeTab(infra);
      tabA.persistence.enqueue('update', stashed({ n: 1 }));
      await Promise.resolve();
      tabA.injector.destroy();

      const tabB = makeTab(infra);
      persistedResource(tabB.injector);
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }]);
    });

    it('a LockManager that rejects every request falls back to per-instance replay', async () => {
      const infra = shared([{ n: 7, session: 's-old' }], {
        locks: createRejectingLocks(),
      });
      const tab = makeTab(infra);
      const pending = pendingOf(tab);
      persistedResource(tab.injector);
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
      expect(pending.count()).toBe(0);
    });

    it('navigator.locks is the default lock manager in the browser', async () => {
      const locks = createFakeLocks();
      vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
      configureRoot({ server, locks: 'platform' });
      const infra: SharedInfra = {
        db: provideMockMutationPersistence({
          rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
        }),
        locks: null,
      };
      const tabs = [makeTab(infra, true), makeTab(infra, true)];
      for (const tab of tabs) persistedResource(tab.injector);
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
      vi.unstubAllGlobals();
    });

    it('each key has its own replay lock', async () => {
      const infra = shared([
        { key: 'a', n: 1 },
        { key: 'b', n: 2 },
      ]);
      const tab = makeTab(infra);
      persistedResource(tab.injector, { key: 'a' });
      persistedResource(tab.injector, { key: 'b' });
      await settle();
      expect(server.calls.map((c) => c.url).toSorted()).toEqual([
        'https://x.test/a',
        'https://x.test/b',
      ]);
    });

    it('a released claim never replays while another tab holds the lock', async () => {
      const infra = shared([], { sync: false });
      const tab1 = makeTab(infra);
      const first = persistedResource(tab1.injector);
      await settle();
      first.destroy();
      const tab2 = offline(makeTab(infra));
      persistedResource(tab2.injector);
      await settle();
      persistedResource(tab1.injector);
      await settle();

      tab1.persistence.enqueue('update', stashed({ n: 4 }));
      tab1.persistence.flush('update');
      await settle();
      expect(server.bodies()).toEqual([]);
    });

    it('without Web Locks a sibling stash still shows in pending', async () => {
      const infra = shared([], { locks: null });
      const tabA = makeTab(infra);
      const pendingA = pendingOf(tabA);
      const tabB = offline(makeTab(infra));
      const resB = persistedResource(tabB.injector, { queue: true });
      await settle();
      resB.mutate({ n: 1 });
      expect(pendingA.count()).toBe(1);
    });
  });

  describe('takeover', () => {
    it("a holder's last stash replays after it dies, even if the successor hydrated before it", async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      const resA = persistedResource(tabA.injector, { queue: true });
      const tabB = makeTab(infra);
      persistedResource(tabB.injector);
      await settle();

      resA.mutate({ n: 1 });
      await settle();
      tabA.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }]);
      expect(tabB.persistence.rowsFor('update')).toEqual([]);
    });

    it('rows a living writer stashed before and after the successor hydrated all replay on its death', async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      const resA = persistedResource(tabA.injector, { queue: true });
      resA.mutate({ n: 1 });
      await settle();
      const tabB = makeTab(infra);
      persistedResource(tabB.injector, { queue: true });
      await settle();
      resA.mutate({ n: 2 });
      await settle();

      tabA.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('a re-sync only adopts rows of its own key', async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      persistedResource(tabA.injector);
      const other = persistedResource(tabA.injector, { key: 'other' });
      const tabB = makeTab(infra);
      persistedResource(tabB.injector);
      await settle();

      other.mutate({ n: 1 });
      await settle();
      tabA.injector.destroy();
      await settle();
      expect(server.calls).toEqual([]);
    });

    it("a re-sync keeps other keys' rows in pending", async () => {
      const infra = shared([{ n: 1 }, { key: 'other', n: 2 }]);
      const tab = makeTab(infra);
      const pending = pendingOf(tab);
      persistedResource(tab.injector);
      await settle();
      expect(pending.entries().map((e) => e.key)).toEqual(['other']);
    });
  });

  describe('living siblings', () => {
    it('a sibling settling a row before hydration finished keeps it from coming back', async () => {
      const infra = shared([{ n: 7 }], { locks: null });
      const tabA = makeTab(infra);
      const pendingA = pendingOf(tabA);
      persistedResource(tabA.injector);
      infra.hub?.connect().postMessage({
        type: 'mmstack-mutation-sync',
        sender: 's-x',
        action: 'remove',
        id: 'update#1',
      });
      void tabA.injector
        .get(MUTATION_PERSISTENCE_DB)
        .then((db) => db.remove('update#1'));
      await settle();
      expect(pendingA.count()).toBe(0);
      expect(server.calls).toEqual([]);
    });

    it("one sibling's death makes only its own rows replayable", async () => {
      const infra = shared();
      const tabA = makeTab(infra);
      persistedResource(tabA.injector, { queue: true });
      const tabB = offline(makeTab(infra));
      const resB = persistedResource(tabB.injector, { queue: true });
      const tabC = offline(makeTab(infra));
      const resC = persistedResource(tabC.injector, { queue: true });
      await settle();
      resB.mutate({ n: 1 });
      resC.mutate({ n: 2 });
      await settle();

      tabB.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }]);

      tabC.online.set(true);
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("a dying sibling's rows reach every key that has a resource here", async () => {
      const infra = shared();
      const tabA = makeTab(infra);
      persistedResource(tabA.injector);
      await settle();
      const tabB = offline(makeTab(infra));
      const otherB = persistedResource(tabB.injector, { key: 'other' });
      const updateB = persistedResource(tabB.injector);
      await settle();
      otherB.mutate({ n: 1 });
      updateB.mutate({ n: 2 });
      await settle();

      tabB.injector.destroy();
      await settle();
      expect(server.calls.map((c) => [c.url, c.body])).toEqual([
        ['https://x.test/update', { n: 2 }],
      ]);
    });

    it("a re-sync holds back a living sibling's disk rows until that sibling dies", async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      persistedResource(tabA.injector);
      const tabB = makeTab(infra);
      persistedResource(tabB.injector);
      const tabC = offline(makeTab(infra));
      const resC = persistedResource(tabC.injector);
      await settle();
      resC.mutate({ n: 5 });
      await settle();

      tabA.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([]);

      tabC.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 5 }]);
    });

    it('a row sent by one holder is not sent again by the next', async () => {
      const infra = shared([{ n: 3, session: 's-live' }], { sync: false });
      let releaseOwner!: () => void;
      void infra.locks?.request(
        'mmstack-mutation-session:s-live',
        { mode: 'exclusive' },
        () => new Promise<void>((resolve) => (releaseOwner = resolve)),
      );
      await settle();
      const tabA = makeTab(infra);
      persistedResource(tabA.injector);
      const tabC = makeTab(infra);
      persistedResource(tabC.injector);
      await settle();
      expect(server.bodies()).toEqual([]);

      releaseOwner();
      await settle();
      expect(server.bodies()).toEqual([{ n: 3 }]);

      tabA.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 3 }]);
    });
  });

  describe('a re-sync racing a settle', () => {
    function holdableShared(sync = true) {
      configureRoot({ server });
      const map = new Map<string, any>();
      let gate: PromiseWithResolvers<void> | null = null;
      const db = {
        getAll: async () => {
          const snapshot = Array.from(map.values());
          if (gate) await gate.promise;
          return snapshot;
        },
        store: async (entry: any) => {
          map.set(entry.key, entry);
        },
        remove: async (key: string) => {
          map.delete(key);
        },
      };
      const infra: SharedInfra = {
        db: { provide: MUTATION_PERSISTENCE_DB, useValue: Promise.resolve(db) },
        locks: createFakeLocks(),
        hub: sync ? createFakeChannelHub() : undefined,
      };
      return {
        infra,
        hold: () => (gate = Promise.withResolvers<void>()),
        release: () => {
          gate?.resolve();
          gate = null;
        },
      };
    }

    it("a sibling's settle during the re-sync read does not bring its row back", async () => {
      const { infra, hold, release } = holdableShared();
      const tabA = makeTab(infra);
      persistedResource(tabA.injector);
      const tabB = makeTab(infra);
      const pendingB = pendingOf(tabB);
      persistedResource(tabB.injector);
      const tabC = offline(makeTab(infra));
      const resC = persistedResource(tabC.injector, { queue: true });
      await settle();
      resC.mutate({ n: 1 });
      await settle();

      hold();
      tabA.injector.destroy();
      await settle();
      tabC.online.set(true);
      await settle();
      release();
      await settle();

      expect(server.bodies()).toEqual([{ n: 1 }]);
      expect(pendingB.count()).toBe(0);
    });

    it('its own settle during the re-sync read does not make the row replay again', async () => {
      const { infra, hold, release } = holdableShared(false);
      const tabA = makeTab(infra);
      persistedResource(tabA.injector);
      const tabB = offline(makeTab(infra));
      const pendingB = pendingOf(tabB);
      const resB = persistedResource(tabB.injector, { queue: true });
      await settle();
      resB.mutate({ n: 2 });
      await settle();

      hold();
      tabA.injector.destroy();
      await settle();
      tabB.online.set(true);
      await settle();
      release();
      await settle();

      expect(server.bodies()).toEqual([{ n: 2 }]);
      expect(pendingB.count()).toBe(0);
    });

    it('a resource destroyed during its re-sync read leaves no stale hold behind', async () => {
      const { infra, hold, release } = holdableShared(false);
      const tab1 = makeTab(infra);
      await settle();
      hold();
      const first = persistedResource(tab1.injector);
      await settle();
      first.destroy();
      release();
      await settle();

      const tab2 = offline(makeTab(infra));
      persistedResource(tab2.injector);
      await settle();
      persistedResource(tab1.injector);
      await settle();
      tab1.persistence.enqueue('update', stashed({ n: 4 }));
      tab1.persistence.flush('update');
      await settle();
      expect(server.bodies()).toEqual([]);
    });

    it('releasing a held claim frees the lock for the next tab', async () => {
      const infra = shared([{ n: 7 }], { sync: false });
      const tab1 = offline(makeTab(infra));
      const first = persistedResource(tab1.injector);
      await settle();
      expect(tab1.persistence.holdsReplayLock('update')).toBe(true);
      first.destroy();

      const tab2 = makeTab(infra);
      persistedResource(tab2.injector);
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
    });
  });

  describe('ordering and settled rows across takeovers', () => {
    const lastReplay = async (infra: SharedInfra) => {
      server.calls.length = 0;
      persistedResource(makeTab(infra).injector, { queue: true });
      await settle();
      return server.bodies();
    };

    it('a stash made after seeing a sibling stash is newer than it', async () => {
      const infra = shared();
      const tabA = offline(makeTab(infra));
      const resA = persistedResource(tabA.injector, { queue: true });
      const tabB = offline(makeTab(infra));
      const resB = persistedResource(tabB.injector, { queue: true });
      await settle();
      resA.mutate({ n: 1 });
      resA.mutate({ n: 2 });
      resB.mutate({ n: 3 });
      await settle();
      tabA.injector.destroy();
      tabB.injector.destroy();
      await settle();

      expect(await lastReplay(infra)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it('a stash made after a re-sync is newer than every row it adopted', async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      const resA = persistedResource(tabA.injector, { queue: true });
      const tabB = offline(makeTab(infra));
      const resB = persistedResource(tabB.injector, { queue: true });
      await settle();
      resA.mutate({ n: 1 });
      resA.mutate({ n: 2 });
      await settle();
      tabA.injector.destroy();
      await settle();
      resB.mutate({ n: 3 });
      await settle();
      tabB.injector.destroy();
      await settle();

      expect(await lastReplay(infra)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it('a row adopted by a re-sync and sent by another tab is not sent again later', async () => {
      const infra = shared([], { sync: false });
      const tabA = offline(makeTab(infra));
      persistedResource(tabA.injector);
      const tabB = offline(makeTab(infra));
      const firstB = persistedResource(tabB.injector);
      await settle();
      const tabD = offline(makeTab(infra));
      persistedResource(tabD.injector).mutate({ n: 5 });
      await settle();
      tabD.injector.destroy();
      tabA.injector.destroy();
      await settle();

      const tabC = makeTab(infra);
      persistedResource(tabC.injector);
      firstB.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 5 }]);

      tabB.online.set(true);
      persistedResource(tabB.injector);
      tabC.injector.destroy();
      await settle();
      expect(server.bodies()).toEqual([{ n: 5 }]);
    });
  });
});
