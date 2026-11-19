import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransitionScope } from '@mmstack/primitives';
import { mutationResource } from './mutation-resource';
import { injectPendingMutations, provideMockMutationPersistence } from './util';
import { MutationPersistence } from './util/persist-mutations';
import {
  configureRoot,
  createMemoryDB,
  createServer,
  persistedResource,
  type Server,
  settle,
  stashed,
} from './util/testing/persist-harness';

describe('mutation persistence contract (one app)', () => {
  let server: Server;
  const root = () => TestBed.inject(EnvironmentInjector);
  const pending = () =>
    TestBed.runInInjectionContext(() => injectPendingMutations());

  const seeded = (...rows: { key?: string; n: number; session?: string }[]) =>
    provideMockMutationPersistence({
      rows: rows.map((r, i) => ({
        key: r.key ?? 'update',
        raw: stashed({ n: r.n }),
        created: Date.now() - 1000 * (rows.length - i),
        session: r.session,
      })),
    });

  beforeEach(() => {
    server = createServer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('ttl', () => {
    it('a kept failure stops retrying once its ttl has passed, even without a reload', async () => {
      const online = configureRoot({ server });
      server.respond('fail');
      const p = pending();
      persistedResource(root(), {
        persist: { key: 'update', keepOnError: true, ttl: 1000 },
      }).mutate({ n: 1 });
      await settle();
      expect([server.calls.length, p.count()]).toEqual([1, 1]);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
      online.set(false);
      await settle();
      online.set(true);
      await settle();
      p.flush();
      await settle();

      expect(server.calls.length).toBe(1);
      expect(p.count()).toBe(0);
    });
  });

  describe('rows that never ran are dropped', () => {
    it('a request() that returns undefined drops the stash of a plain mutate()', async () => {
      configureRoot({ server });
      const p = pending();
      TestBed.runInInjectionContext(() =>
        mutationResource((_: { n: number }) => undefined, {
          persist: { key: 'update' },
        }),
      ).mutate({ n: 1 });
      await settle();
      expect(p.count()).toBe(0);
    });

    it('a request() that returns undefined rejects mutateAsync and drops its stash', async () => {
      configureRoot({ server });
      const p = pending();
      const res = TestBed.runInInjectionContext(() =>
        mutationResource((_: { n: number }) => undefined, {
          persist: { key: 'update' },
        }),
      );
      await expect(res.mutateAsync({ n: 1 })).rejects.toMatchObject({
        type: 'no-request',
      });
      expect(p.count()).toBe(0);
    });

    it('a throwing optimistic drops the stash', async () => {
      configureRoot({ server, extra: [provideTransitionScope()] });
      const p = pending();
      persistedResource(root(), {
        optimistic: () => {
          throw new Error('nope');
        },
      }).mutate({ n: 1 });
      await settle();
      expect([server.calls.length, p.count()]).toEqual([0, 0]);
    });

    it('a queue key change drops the pending row and keeps the in-flight one', async () => {
      configureRoot({ server });
      server.respond(null);
      const key = signal('a');
      const p = pending();
      const res = persistedResource(root(), { queue: { key: () => key() } });
      res.mutate({ n: 1 });
      res.mutate({ n: 2 });
      await settle();
      expect(p.count()).toBe(2);

      key.set('b');
      await settle();
      expect(p.entries().map((e) => e.raw)).toEqual([stashed({ n: 1 })]);
    });

    it('a row whose deserialize throws is dropped and nothing throws (queue and latest-wins)', async () => {
      for (const queue of [true, false]) {
        TestBed.resetTestingModule();
        configureRoot({
          server,
          persistence: provideMockMutationPersistence({
            rows: [{ key: 'update', raw: 'corrupt' }],
          }),
        });
        const p = pending();
        persistedResource(root(), {
          queue,
          persist: {
            key: 'update',
            deserialize: () => {
              throw new Error('corrupt');
            },
          },
        });
        await settle();
        expect(p.count()).toBe(0);
      }
      expect(server.calls.length).toBe(0);
    });
  });

  describe('a stash whose serialize throws runs unpersisted', () => {
    const serialize = () => {
      throw new Error('not cloneable');
    };

    it('latest-wins: superseding it does not throw and the newer request goes out', async () => {
      configureRoot({ server });
      server.respond(null);
      const res = persistedResource(root(), {
        persist: { key: 'update', serialize },
      });
      res.mutate({ n: 1 });
      await settle();
      expect(() => res.mutate({ n: 2 })).not.toThrow();
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('queue: clearQueue() does not throw', async () => {
      configureRoot({ server });
      server.respond(null);
      const res = persistedResource(root(), {
        queue: true,
        persist: { key: 'update', serialize },
      });
      res.mutate({ n: 1 });
      res.mutate({ n: 2 });
      await settle();
      expect(() => res.clearQueue()).not.toThrow();
    });
  });

  describe('keepOnError', () => {
    it('the predicate receives the replayed flag', async () => {
      configureRoot({
        server,
        persistence: provideMockMutationPersistence({
          rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
        }),
      });
      server.respond('fail');
      const p = pending();
      const res = persistedResource(root(), {
        persist: { key: 'update', keepOnError: (_e, meta) => meta.replayed },
      });
      await settle();
      expect(p.entries().map((e) => e.raw)).toEqual([stashed({ n: 7 })]);

      res.mutate({ n: 1 });
      await settle();
      expect(p.entries().map((e) => e.raw)).toEqual([stashed({ n: 7 })]);
    });

    it('keepOnError: true still drops the stash on success', async () => {
      configureRoot({ server });
      const p = pending();
      persistedResource(root(), {
        persist: { key: 'update', keepOnError: true },
      }).mutate({ n: 1 });
      await settle();
      expect([server.calls.length, p.count()]).toEqual([1, 0]);
    });
  });

  describe('replay', () => {
    it('waits offline without running any hook, then replays on regain', async () => {
      const online = configureRoot({ server, persistence: seeded({ n: 7 }) });
      online.set(false);
      const onMutate = vi.fn();
      const res = persistedResource(root(), { onMutate });
      await settle();
      expect([onMutate.mock.calls.length, res.current()]).toEqual([0, null]);

      online.set(true);
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
    });

    it('a stash made after hydration is newer than every hydrated row', async () => {
      const online = configureRoot({
        server,
        persistence: seeded({ n: 1 }, { n: 2 }),
      });
      online.set(false);
      const writer = persistedResource(root());
      await settle();
      writer.mutate({ n: 3 });
      writer.destroy();
      online.set(true);
      persistedResource(root());
      await settle();
      expect(server.bodies()).toEqual([{ n: 3 }]);
    });

    it('a row from a previous session replays when Web Locks are missing', async () => {
      configureRoot({ server, persistence: seeded({ n: 7, session: 'prev' }) });
      persistedResource(root());
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
    });

    it('replays only its own key and leaves other keys pending', async () => {
      configureRoot({
        server,
        persistence: seeded({ n: 7 }, { key: 'other', n: 8 }),
      });
      const p = pending();
      persistedResource(root());
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
      expect(p.entries().map((e) => e.key)).toEqual(['other']);
    });

    it('replays oldest first whatever order the database returns', async () => {
      const mem = createMemoryDB((rows) => rows.toReversed());
      configureRoot({ server, persistence: mem.provider });
      server.respond(null);
      const writer = persistedResource(root(), { queue: true });
      writer.mutate({ n: 1 });
      writer.mutate({ n: 2 });
      await settle();
      writer.destroy();
      server.calls.length = 0;
      server.respond('ok');

      TestBed.resetTestingModule();
      configureRoot({ server, persistence: mem.provider });
      persistedResource(root(), { queue: true });
      await settle();
      expect(server.bodies()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('queue: a replay while rows are queued sends each row once', async () => {
      configureRoot({ server });
      server.respond(null);
      const p = pending();
      const res = persistedResource(root(), { queue: true });
      res.mutate({ n: 1 });
      res.mutate({ n: 2 });
      await settle();
      p.flush();
      await settle();
      while (server.calls.some((c) => c.res.observed)) {
        server.calls.find((c) => c.res.observed)?.ok();
        await settle();
      }
      expect(server.bodies()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('queue: a replayed failure reports { replayed: true }', async () => {
      configureRoot({ server, persistence: seeded({ n: 7 }) });
      server.respond('fail');
      const metas: unknown[] = [];
      persistedResource(root(), {
        queue: true,
        onError: (_e, _c, meta) => metas.push(meta),
      });
      await settle();
      expect(metas).toEqual([{ replayed: true }]);
    });

    it('an explicit injector works outside an injection context', async () => {
      const online = configureRoot({ server, persistence: seeded({ n: 7 }) });
      online.set(false);
      const injector = TestBed.inject(Injector);
      expect(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/u',
            method: 'POST',
            body,
          }),
          { injector, persist: { key: 'update' } },
        ),
      ).not.toThrow();
      await settle();
      online.set(true);
      await settle();
      expect(server.bodies()).toEqual([{ n: 7 }]);
    });
  });

  describe('flush()', () => {
    it('retries a kept failure, scoped to the key it names', async () => {
      configureRoot({ server });
      server.respond('fail');
      const p = pending();
      const metas: [string, boolean][] = [];
      for (const key of ['a', 'b'])
        persistedResource(root(), {
          key,
          persist: { key, keepOnError: true },
          onError: (_e, _c, meta) => metas.push([key, meta.replayed]),
        }).mutate({ n: 1 });
      await settle();
      expect(metas).toEqual([
        ['a', false],
        ['b', false],
      ]);

      p.flush('a');
      await settle();
      expect(metas.slice(2)).toEqual([['a', true]]);

      p.flush();
      await settle();
      expect(metas.slice(3).toSorted()).toEqual([
        ['a', true],
        ['b', true],
      ]);
      expect(() => p.flush('nope')).not.toThrow();
    });
  });

  describe('claims', () => {
    it('a stale release from a destroyed resource does not evict the current claimant', async () => {
      const online = configureRoot({ server });
      const child = createEnvironmentInjector([], root());
      persistedResource(child).destroy();
      persistedResource(root());
      child.destroy();

      online.set(false);
      await settle();
      TestBed.inject(MutationPersistence).enqueue('update', stashed({ n: 9 }));
      online.set(true);
      await settle();
      expect(server.bodies()).toEqual([{ n: 9 }]);
    });

    it('a resource destroyed before hydration never replays', async () => {
      configureRoot({ server, persistence: seeded({ n: 7 }) });
      const child = createEnvironmentInjector([], root());
      const gone = vi.fn();
      const kept = vi.fn();
      persistedResource(child, { onMutate: gone });
      child.destroy();
      persistedResource(root(), { onMutate: kept });
      await settle();
      expect([gone.mock.calls.length, kept.mock.calls.length]).toEqual([0, 1]);
    });
  });
});
