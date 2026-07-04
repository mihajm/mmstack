import {
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpRequest,
} from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type Provider,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { delay, of, throwError } from 'rxjs';
import { mutationResource } from './mutation-resource';
import {
  injectPendingMutations,
  provideMockMutationPersistence,
  provideQueryCache,
  ResourceSensors,
} from './util';
import {
  MUTATION_PERSISTENCE_DB,
  MUTATION_REPLAY_LOCKS,
  MUTATION_SYNC,
  MutationPersistence,
  type MutationSyncChannel,
} from './util/persist-mutations';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
  delayMs: number;
}>(() => ({
  validate: () => {
    /* noop */
  },
  returnValue: null,
  shouldThrow: false,
  delayMs: 0,
}));

function ctx(
  validate: (req: HttpRequest<any>) => void,
  returnValue: any = { ok: true },
  shouldThrow = false,
  delayMs = 0,
) {
  return new HttpContext().set(TEST_CONTEXT, {
    validate,
    returnValue,
    shouldThrow,
    delayMs,
  });
}

const testInterceptor = (req: HttpRequest<any>) => {
  const { validate, shouldThrow, returnValue, delayMs } =
    req.context.get(TEST_CONTEXT);
  validate(req);

  if (shouldThrow) {
    const err$ = throwError(
      () => new HttpErrorResponse({ error: 'Test error', status: 500 }),
    );
    return delayMs ? err$.pipe(delay(delayMs)) : err$;
  }

  const res$ = of(new HttpResponse({ body: returnValue, status: 200 }));
  return delayMs ? res$.pipe(delay(delayMs)) : res$;
};

const stashed = (mutation: unknown, ictx?: unknown) => ({
  mutation,
  ctx: ictx,
});

describe('mutation persistence', () => {
  let online: WritableSignal<boolean>;

  function configure(seed?: Parameters<typeof provideMockMutationPersistence>[0]) {
    online = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideMockMutationPersistence(seed),
        { provide: MUTATION_SYNC, useValue: null },
        { provide: ResourceSensors, useValue: { networkStatus: online } },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });
  }

  const hydrate = async () => {
    await TestBed.inject(MutationPersistence).whenHydrated;
    await Promise.resolve();
    TestBed.tick();
  };

  describe('registry surface', () => {
    it('enqueue/remove reflect synchronously in the pending signal', () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );

      expect(pending.count()).toBe(0);
      const id = persistence.enqueue('k', stashed({ n: 1 }));
      expect(pending.count()).toBe(1);
      expect(pending.entries()[0]).toMatchObject({ key: 'k', id });

      persistence.remove(id);
      expect(pending.count()).toBe(0);
    });

    it('hydrates rows from a previous session and filters expired ones', async () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      configure({
        rows: [
          { key: 'k', raw: stashed({ n: 1 }) },
          { key: 'k', raw: stashed({ n: 0 }), created: eightDaysAgo },
        ],
      });
      const persistence = TestBed.inject(MutationPersistence);
      await persistence.whenHydrated;

      expect(persistence.rowsFor('k').length).toBe(1);
    });

    it('entries for keys with no live resource are visible but inert', async () => {
      configure({ rows: [{ key: 'never-instantiated', raw: stashed({}) }] });
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );
      await hydrate();

      expect(pending.count()).toBe(1);
      pending.flush();
      await hydrate();
      expect(pending.count()).toBe(1);
    });
  });

  describe('stash lifecycle within a session', () => {
    it('stashes on mutate, shows as pending while in flight, and clears on success', async () => {
      configure();
      const settled = Promise.withResolvers<void>();
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, { ok: true }, false, 20),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      ).mutate({ n: 1 });

      expect(pending.count()).toBe(1);
      await settled.promise;
      expect(pending.count()).toBe(0);
    });

    it('clears the stash on error and reports replayed: false', async () => {
      configure();
      const settled = Promise.withResolvers<void>();
      const metas: boolean[] = [];
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, null, true),
          }),
          {
            persist: { key: 'update' },
            onError: (_err, _ctx, meta) => metas.push(meta.replayed),
            onSettled: () => settled.resolve(),
          },
        ),
      ).mutate({ n: 1 });

      await settled.promise;
      expect(metas).toEqual([false]);
      expect(pending.count()).toBe(0);
    });

    it('a superseded mutation loses its stash; the superseding one keeps its own', async () => {
      configure();
      const settled = Promise.withResolvers<void>();
      const persistence = TestBed.inject(MutationPersistence);

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, { ok: true }, false, 30),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );

      res.mutate({ n: 1 });
      const firstId = persistence.rowsFor('update')[0]?.id;
      res.mutate({ n: 2 });

      const rows = persistence.rowsFor('update');
      expect(rows.length).toBe(1);
      expect(rows[0].id).not.toBe(firstId);

      await settled.promise;
    });

    it('destroy PRESERVES stashes (survival is the point) and releases the claim', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, { ok: true }, false, 5000),
          }),
          { persist: { key: 'update' } },
        ),
      );

      res.mutate({ n: 1 });
      expect(persistence.rowsFor('update').length).toBe(1);

      res.destroy();
      expect(persistence.rowsFor('update').length).toBe(1);

      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];
      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );
      await hydrate();
      await settled.promise;
      expect(bodies).toEqual([{ n: 1 }]);
      expect(persistence.rowsFor('update').length).toBe(0);
    });

    it('clearQueue drops the pending entries AND their stashes', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, { ok: true }, false, 5000),
          }),
          { persist: { key: 'update' }, queue: true },
        ),
      );

      res.mutate({ n: 1 });
      res.mutate({ n: 2 });
      res.mutate({ n: 3 });
      TestBed.tick();
      expect(persistence.rowsFor('update').length).toBe(3);

      res.clearQueue();
      expect(persistence.rowsFor('update').length).toBe(1);
    });
  });

  describe('replay', () => {
    it('replays a stashed mutation on instantiation, through the normal hooks', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }, 'ictx') }] });
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];
      const hooks: string[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            onMutate: (value, ictx) => {
              hooks.push(`onMutate:${value.n}:${ictx}`);
              return 'ctx';
            },
            onSuccess: (_v, c) => hooks.push(`onSuccess:${c}`),
            onSettled: () => settled.resolve(),
          },
        ),
      );

      await hydrate();
      await settled.promise;

      expect(bodies).toEqual([{ n: 7 }]);
      expect(hooks).toEqual(['onMutate:7:ictx', 'onSuccess:ctx']);
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]);
    });

    it('a replayed failure reports replayed: true and still clears the stash', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }) }] });
      const settled = Promise.withResolvers<void>();
      const metas: boolean[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, null, true),
          }),
          {
            persist: { key: 'update' },
            onError: (_e, _c, meta) => metas.push(meta.replayed),
            onSettled: () => settled.resolve(),
          },
        ),
      );

      await hydrate();
      await settled.promise;
      expect(metas).toEqual([true]);
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]);
    });

    it('waits for the network: no replay offline, replays on regain', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }) }] });
      online.set(false);
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );

      await hydrate();
      expect(bodies).toEqual([]);
      expect(TestBed.inject(MutationPersistence).rowsFor('update').length).toBe(1);

      online.set(true);
      TestBed.tick();
      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]);
    });

    it('queue mode replays per-key FIFO, oldest first', async () => {
      configure({
        rows: [
          { key: 'update', raw: stashed({ n: 1 }), created: Date.now() - 2000 },
          { key: 'update', raw: stashed({ n: 2 }), created: Date.now() - 1000 },
        ],
      });
      const settled = Promise.withResolvers<void>();
      const bodies: { n: number }[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body as { n: number })),
          }),
          {
            persist: { key: 'update' },
            queue: true,
            onSettled: () => {
              if (bodies.length === 2) settled.resolve();
            },
          },
        ),
      );

      await hydrate();
      await settled.promise;
      expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]);
    });

    it('non-queue replays only the NEWEST stash (latest-wins across sessions)', async () => {
      configure({
        rows: [
          { key: 'update', raw: stashed({ n: 1 }), created: Date.now() - 2000 },
          { key: 'update', raw: stashed({ n: 2 }), created: Date.now() - 1000 },
        ],
      });
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );

      await hydrate();
      await settled.promise;
      expect(bodies).toEqual([{ n: 2 }]);
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]);
    });

    it('a live session mutation beats any stash (non-queue latest-wins)', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 1 }) }] });
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];

      const res = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body), { ok: true }, false, 20),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );

      res.mutate({ n: 99 });
      await hydrate();
      await settled.promise;

      expect(bodies).toEqual([{ n: 99 }]);
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]);
    });

    it('a second resource on the same key warns and does not double-replay', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }) }] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];

      const make = () =>
        TestBed.runInInjectionContext(() =>
          mutationResource(
            (body: { n: number }) => ({
              url: 'https://x.test/m',
              method: 'POST',
              body,
              context: ctx((req) => bodies.push(req.body)),
            }),
            {
              persist: { key: 'update' },
              onSettled: () => settled.resolve(),
            },
          ),
        );
      make();
      make();

      await hydrate();
      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("persist under key 'update'"),
      );
      warn.mockRestore();
    });

    it('honors custom serialize/deserialize round-trips', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);
      const firstSettled = Promise.withResolvers<void>();

      const first = TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { when: Date }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, { ok: true }, false, 5000),
          }),
          {
            persist: {
              key: 'dated',
              serialize: (m) => ({ iso: m.when.toISOString() }),
              deserialize: (raw) => ({
                mutation: { when: new Date((raw as { iso: string }).iso) },
              }),
            },
          },
        ),
      );
      first.mutate({ when: new Date('2026-07-02T10:00:00Z') });
      expect(persistence.rowsFor('dated')[0].raw).toEqual({
        iso: '2026-07-02T10:00:00.000Z',
      });
      first.destroy();

      const bodies: unknown[] = [];
      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { when: Date }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body: { iso: body.when.toISOString() },
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: {
              key: 'dated',
              serialize: (m) => ({ iso: m.when.toISOString() }),
              deserialize: (raw) => ({
                mutation: { when: new Date((raw as { iso: string }).iso) },
              }),
            },
            onSettled: () => firstSettled.resolve(),
          },
        ),
      );
      await hydrate();
      await firstSettled.promise;
      expect(bodies).toEqual([{ iso: '2026-07-02T10:00:00.000Z' }]);
    });

    it('an onMutate throw during replay drops the stash instead of boot-looping', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }) }] });
      const persistence = TestBed.inject(MutationPersistence);
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined),
          }),
          {
            persist: { key: 'update' },
            onMutate: () => {
              throw new Error('hook crash');
            },
          },
        ),
      );

      await hydrate();
      expect(persistence.rowsFor('update')).toEqual([]);
      err.mockRestore();
    });

    it('keepOnError: true keeps the stash through a failure for another replay attempt', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);
      let settled = Promise.withResolvers<void>();
      const attempts: boolean[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, null, true),
          }),
          {
            persist: { key: 'update', keepOnError: true },
            onError: (_e, _c, meta) => attempts.push(meta.replayed),
            onSettled: () => settled.resolve(),
          },
        ),
      ).mutate({ n: 1 });

      await settled.promise;
      expect(attempts).toEqual([false]);
      expect(persistence.rowsFor('update').length).toBe(1);

      settled = Promise.withResolvers<void>();
      online.set(false);
      TestBed.tick();
      online.set(true);
      TestBed.tick();
      await settled.promise;
      expect(attempts).toEqual([false, true]);
      expect(persistence.rowsFor('update').length).toBe(1);
    });

    it('keepOnError predicate decides per error (drop when it returns false)', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);
      const settled = Promise.withResolvers<void>();
      const seen: unknown[] = [];

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx(() => undefined, null, true),
          }),
          {
            persist: {
              key: 'update',
              keepOnError: (err) => {
                seen.push(err);
                return false;
              },
            },
            onSettled: () => settled.resolve(),
          },
        ),
      ).mutate({ n: 1 });

      await settled.promise;
      expect(seen.length).toBe(1);
      expect(persistence.rowsFor('update')).toEqual([]);
    });

    it('flush() forces a replay attempt for a claimed key', async () => {
      configure({ rows: [{ key: 'update', raw: stashed({ n: 7 }) }] });
      online.set(false);
      const settled = Promise.withResolvers<void>();
      const bodies: unknown[] = [];
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );

      TestBed.runInInjectionContext(() =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            onSettled: () => settled.resolve(),
          },
        ),
      );
      await hydrate();

      pending.flush('update');
      expect(bodies).toEqual([]);

      online.set(true);
      pending.flush('update');
      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]);
    });
  });

  describe('cross-tab replay claim (Web Locks)', () => {
    function createFakeLocks(): LockManager {
      type Mode = 'exclusive' | 'shared';
      type Waiter = { mode: Mode; grant: () => void; aborted: boolean };
      const held = new Map<string, { mode: Mode }[]>();
      const queues = new Map<string, Waiter[]>();
      const holdersOf = (name: string) => {
        let holders = held.get(name);
        if (!holders) held.set(name, (holders = []));
        return holders;
      };
      const compatible = (name: string, mode: Mode) => {
        const holders = holdersOf(name);
        return (
          !holders.length ||
          (mode === 'shared' && holders.every((h) => h.mode === 'shared'))
        );
      };
      const pump = (name: string) => {
        const queue = queues.get(name) ?? [];
        while (queue.length) {
          const next = queue[0];
          if (next.aborted) {
            queue.shift();
            continue;
          }
          if (!compatible(name, next.mode)) break;
          queue.shift();
          next.grant();
        }
      };
      const acquire = (name: string, mode: Mode) => {
        const holder = { mode };
        holdersOf(name).push(holder);
        return () => {
          const holders = holdersOf(name);
          const idx = holders.indexOf(holder);
          if (idx >= 0) holders.splice(idx, 1);
          pump(name);
        };
      };
      const request = async (
        name: string,
        options: { mode?: Mode; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<unknown>,
      ) => {
        const mode = options?.mode ?? 'exclusive';
        if (options?.ifAvailable) {
          if (!compatible(name, mode)) return callback(null);
          const release = acquire(name, mode);
          try {
            return await callback({});
          } finally {
            release();
          }
        }
        const signal = options?.signal;
        const release = await new Promise<() => void>((grant, reject) => {
          if (signal?.aborted)
            return reject(new DOMException('aborted', 'AbortError'));
          if (compatible(name, mode)) return grant(acquire(name, mode));
          const waiter: Waiter = {
            mode,
            grant: () => grant(acquire(name, mode)),
            aborted: false,
          };
          const queue = queues.get(name) ?? [];
          queue.push(waiter);
          queues.set(name, queue);
          signal?.addEventListener('abort', () => {
            waiter.aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
        try {
          return await callback({});
        } finally {
          release();
        }
      };
      return { request } as unknown as LockManager;
    }

    function createFakeChannelHub() {
      const channels = new Set<MutationSyncChannel>();
      return {
        connect(): MutationSyncChannel {
          const channel: MutationSyncChannel = {
            onmessage: null,
            postMessage(message: unknown) {
              for (const other of channels)
                if (other !== channel)
                  other.onmessage?.({ data: message } as MessageEvent);
            },
            close() {
              channels.delete(channel);
            },
          };
          channels.add(channel);
          return channel;
        },
      };
    }

    type SharedInfra = {
      db: Provider;
      locks: LockManager;
      hub?: ReturnType<typeof createFakeChannelHub>;
    };

    type Tab = {
      injector: EnvironmentInjector;
      online: WritableSignal<boolean>;
      persistence: MutationPersistence;
    };

    function configureShared(
      seed?: Parameters<typeof provideMockMutationPersistence>[0],
      opts?: { sync?: boolean },
    ): SharedInfra {
      configure();
      return {
        db: provideMockMutationPersistence(seed),
        locks: createFakeLocks(),
        hub: opts?.sync === false ? undefined : createFakeChannelHub(),
      };
    }

    function makeTab(shared: SharedInfra): Tab {
      const tabOnline = signal(true);
      const injector = createEnvironmentInjector(
        [
          MutationPersistence,
          shared.db,
          { provide: MUTATION_REPLAY_LOCKS, useValue: shared.locks },
          { provide: MUTATION_SYNC, useValue: shared.hub?.connect() ?? null },
          { provide: ResourceSensors, useValue: { networkStatus: tabOnline } },
        ],
        TestBed.inject(EnvironmentInjector),
      );
      return {
        injector,
        online: tabOnline,
        persistence: injector.get(MutationPersistence),
      };
    }

    const makeResource = (
      tab: Tab,
      bodies: unknown[],
      opts?: { queue?: boolean; onSettled?: () => void },
    ) =>
      runInInjectionContext(tab.injector, () =>
        mutationResource(
          (body: { n: number }) => ({
            url: 'https://x.test/m',
            method: 'POST',
            body,
            context: ctx((req) => bodies.push(req.body)),
          }),
          {
            persist: { key: 'update' },
            queue: opts?.queue ?? false,
            onSettled: opts?.onSettled,
          },
        ),
      );

    const settle = async () => {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 10; i++) await Promise.resolve();
        TestBed.tick();
      }
    };

    it('only the tab holding the per-key lock replays a stash', async () => {
      const shared = configureShared({
        rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
      });
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      const tabB = makeTab(shared);
      makeResource(tabA, bodies, { onSettled: () => settled.resolve() });
      makeResource(tabB, bodies, { onSettled: () => settled.resolve() });

      await settled.promise;
      await settle();

      expect(bodies).toEqual([{ n: 7 }]);
      expect(tabA.persistence.holdsReplayLock('update')).toBe(true);
      expect(tabB.persistence.holdsReplayLock('update')).toBe(false);
      expect(tabA.persistence.rowsFor('update')).toEqual([]);
    });

    it('flush() in a tab that does not hold the lock is a safe no-op', async () => {
      const shared = configureShared({
        rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
      });
      const bodies: unknown[] = [];

      const tabA = makeTab(shared);
      tabA.online.set(false);
      makeResource(tabA, bodies);
      const tabB = makeTab(shared);
      makeResource(tabB, bodies);
      await settle();

      tabB.persistence.flush('update');
      await settle();
      expect(bodies).toEqual([]);
      expect(tabB.persistence.rowsFor('update').length).toBe(1);
    });

    it('a closing holder hands over: the next tab re-syncs and replays leftovers', async () => {
      const shared = configureShared({
        rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
      });
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      tabA.online.set(false);
      makeResource(tabA, bodies);
      const tabB = makeTab(shared);
      makeResource(tabB, bodies, { onSettled: () => settled.resolve() });
      await settle();
      expect(bodies).toEqual([]);

      tabA.injector.destroy();

      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]);
      expect(tabB.persistence.holdsReplayLock('update')).toBe(true);
      expect(tabB.persistence.rowsFor('update')).toEqual([]);
    });

    it('takeover does not resurrect rows the previous holder already settled', async () => {
      const shared = configureShared(
        {
          rows: [
            { key: 'update', raw: stashed({ n: 1 }), created: Date.now() - 2000 },
            { key: 'update', raw: stashed({ n: 2 }), created: Date.now() - 1000 },
          ],
        },
        { sync: false },
      );
      const bodies: unknown[] = [];
      const bothSettled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      tabA.online.set(false);
      makeResource(tabA, bodies, {
        queue: true,
        onSettled: () => {
          if (bodies.length === 2) bothSettled.resolve();
        },
      });
      const tabB = makeTab(shared);
      makeResource(tabB, bodies, { queue: true });
      await settle();
      expect(tabB.persistence.rowsFor('update').length).toBe(2);

      tabA.online.set(true);
      await settle();
      await bothSettled.promise;
      expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);

      tabA.injector.destroy();
      await settle();

      expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);
      expect(tabB.persistence.holdsReplayLock('update')).toBe(true);
      expect(tabB.persistence.rowsFor('update')).toEqual([]);
    });

    it('a re-sync never drops rows this session stashed (IDB write still in flight)', async () => {
      configure();
      const store = new Map<string, any>();
      let holdWrites = false;
      const heldWrites: (() => void)[] = [];
      const db = {
        getAll: async () => Array.from(store.values()),
        store: async (entry: any) => {
          if (holdWrites)
            await new Promise<void>((r) =>
              heldWrites.push(() => {
                store.set(entry.key, entry);
                r();
              }),
            );
          else store.set(entry.key, entry);
        },
        remove: async (key: string) => {
          store.delete(key);
        },
      };
      const shared = {
        db: {
          provide: MUTATION_PERSISTENCE_DB,
          useValue: Promise.resolve(db),
        } as Provider,
        locks: createFakeLocks(),
      };

      const bodies: unknown[] = [];
      const tabA = makeTab(shared);
      tabA.online.set(false);
      makeResource(tabA, bodies);

      const tabB = makeTab(shared);
      tabB.online.set(false);
      const resB = makeResource(tabB, bodies, { queue: true });
      await settle();

      holdWrites = true;
      resB.mutate({ n: 42 });
      expect(tabB.persistence.rowsFor('update').length).toBe(1);

      tabA.injector.destroy();
      await settle();

      expect(tabB.persistence.rowsFor('update').length).toBe(1);
      for (const write of heldWrites.splice(0)) write();
    });

    it("a sibling's stash shows in pending live, is never replayed here, and clears on its settle", async () => {
      const shared = configureShared();
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      makeResource(tabA, bodies);
      const pendingA = runInInjectionContext(tabA.injector, () =>
        injectPendingMutations(),
      );
      const tabB = makeTab(shared);
      tabB.online.set(false);
      const resB = makeResource(tabB, bodies, {
        queue: true,
        onSettled: () => settled.resolve(),
      });
      await settle();

      resB.mutate({ n: 5 });
      expect(pendingA.count()).toBe(1);

      pendingA.flush('update');
      await settle();
      expect(bodies).toEqual([]);
      expect(tabA.persistence.rowsFor('update')).toEqual([]);

      tabB.online.set(true);
      await settle();
      await settled.promise;
      expect(bodies).toEqual([{ n: 5 }]);
      expect(pendingA.count()).toBe(0);
    });

    it("a dying sibling's announced rows replay here the moment it dies (death-watch)", async () => {
      const shared = configureShared();
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      makeResource(tabA, bodies, { onSettled: () => settled.resolve() });
      const pendingA = runInInjectionContext(tabA.injector, () =>
        injectPendingMutations(),
      );
      const tabB = makeTab(shared);
      tabB.online.set(false);
      const resB = makeResource(tabB, bodies, { queue: true });
      await settle();

      resB.mutate({ n: 9 });
      await settle();
      expect(bodies).toEqual([]);
      expect(pendingA.count()).toBe(1);

      tabB.injector.destroy();

      await settled.promise;
      expect(bodies).toEqual([{ n: 9 }]);
      expect(pendingA.count()).toBe(0);
    });

    it('hydrated disk rows written by a still-living tab are held back until it dies', async () => {
      const shared = configureShared({
        rows: [{ key: 'update', raw: stashed({ n: 3 }), session: 's-live' }],
      });
      let releaseOwner!: () => void;
      void shared.locks.request(
        'mmstack-mutation-session:s-live',
        { mode: 'exclusive' },
        () => new Promise<void>((resolve) => (releaseOwner = resolve)),
      );

      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();
      const tabA = makeTab(shared);
      makeResource(tabA, bodies, { onSettled: () => settled.resolve() });
      const pendingA = runInInjectionContext(tabA.injector, () =>
        injectPendingMutations(),
      );
      await settle();

      expect(pendingA.count()).toBe(1);
      expect(tabA.persistence.rowsFor('update')).toEqual([]);
      expect(bodies).toEqual([]);

      releaseOwner();
      await settled.promise;
      expect(bodies).toEqual([{ n: 3 }]);
      expect(pendingA.count()).toBe(0);
    });
  });
});
