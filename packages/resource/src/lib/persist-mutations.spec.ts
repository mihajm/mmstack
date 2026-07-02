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

/** Default-serializer envelope, as a previous session would have stashed it. */
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
        // deterministic single-tab env: no ambient channel (Node ships a global
        // BroadcastChannel); the cross-tab suite wires explicit fakes instead
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
    await Promise.resolve(); // let the post-hydration replay microtask run
    TestBed.tick(); // ...and any queue/network effects it scheduled
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
          { key: 'k', raw: stashed({ n: 0 }), created: eightDaysAgo }, // past ttl
        ],
      });
      const persistence = TestBed.inject(MutationPersistence);
      await persistence.whenHydrated;

      expect(persistence.rowsFor('k').length).toBe(1); // the expired stash never surfaces
    });

    it('entries for keys with no live resource are visible but inert', async () => {
      configure({ rows: [{ key: 'never-instantiated', raw: stashed({}) }] });
      const pending = TestBed.runInInjectionContext(() =>
        injectPendingMutations(),
      );
      await hydrate();

      expect(pending.count()).toBe(1); // visible…
      pending.flush(); // …but nothing claims the key, so this is a safe no-op
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

      expect(pending.count()).toBe(1); // stashed synchronously at accept time
      await settled.promise;
      expect(pending.count()).toBe(0); // settled — stash removed
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
      expect(pending.count()).toBe(0); // an error is settled — no boot-loop retries
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
      res.mutate({ n: 2 }); // latest-wins supersede

      const rows = persistence.rowsFor('update');
      expect(rows.length).toBe(1);
      expect(rows[0].id).not.toBe(firstId); // n:1's stash went with it

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
            context: ctx(() => undefined, { ok: true }, false, 5000), // never settles in-test
          }),
          { persist: { key: 'update' } },
        ),
      );

      res.mutate({ n: 1 });
      expect(persistence.rowsFor('update').length).toBe(1);

      res.destroy();
      expect(persistence.rowsFor('update').length).toBe(1); // survives for next session

      // the claim was released: a new resource can claim + replay the surviving stash
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

      res.mutate({ n: 1 }); // becomes in-flight after the queue effect runs
      res.mutate({ n: 2 }); // stays pending
      res.mutate({ n: 3 }); // stays pending
      TestBed.tick();
      expect(persistence.rowsFor('update').length).toBe(3);

      res.clearQueue(); // drops the two pending; in-flight n:1 unaffected
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
      // lexical hooks fired, with the deserialized initial ctx — the reason replay
      // activates at instantiation
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
      expect(bodies).toEqual([]); // offline — stash stays put
      expect(TestBed.inject(MutationPersistence).rowsFor('update').length).toBe(1);

      online.set(true);
      TestBed.tick(); // regain effect
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

      res.mutate({ n: 99 }); // issued before hydration finishes — it is the newest intent
      await hydrate();
      await settled.promise;

      expect(bodies).toEqual([{ n: 99 }]); // the stash never fired…
      expect(TestBed.inject(MutationPersistence).rowsFor('update')).toEqual([]); // …and was dropped
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
      expect(bodies).toEqual([{ n: 7 }]); // exactly one replay
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("persist under key 'update'"),
      );
      warn.mockRestore();
    });

    it('honors custom serialize/deserialize round-trips', async () => {
      configure();
      const persistence = TestBed.inject(MutationPersistence);
      const firstSettled = Promise.withResolvers<void>();

      // session 1: stash with a custom encoding, "close the app" before it settles
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

      // session 2: the replayed mutation is a real Date again
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
      expect(persistence.rowsFor('update')).toEqual([]); // settled-by-abort, not retried
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
            context: ctx(() => undefined, null, true), // always fails
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
      expect(persistence.rowsFor('update').length).toBe(1); // survived the failure

      settled = Promise.withResolvers<void>();
      online.set(false);
      TestBed.tick(); // let the regain effect observe the offline state…
      online.set(true);
      TestBed.tick(); // …so this transition counts as a regain → replays the kept stash
      await settled.promise;
      expect(attempts).toEqual([false, true]); // the retry ran as a replay
      expect(persistence.rowsFor('update').length).toBe(1); // still failing → still kept
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
                return false; // "permanent failure" — drop it
              },
            },
            onSettled: () => settled.resolve(),
          },
        ),
      ).mutate({ n: 1 });

      await settled.promise;
      expect(seen.length).toBe(1);
      expect(persistence.rowsFor('update')).toEqual([]); // predicate said drop
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

      pending.flush('update'); // offline — replayer refuses
      expect(bodies).toEqual([]);

      online.set(true); // regain is enough on its own, but exercise the manual path:
      pending.flush('update');
      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]);
    });
  });

  describe('cross-tab replay claim (Web Locks)', () => {
    /**
     * A faithful in-memory Web Lock manager: exclusive/shared modes, `ifAvailable`,
     * FIFO grants, abortable pending requests, release on callback settle — the
     * semantics the replay claim, session probes, and death-watches rely on. Real
     * `navigator.locks` (incl. release-on-tab-close) is covered by the playground
     * e2e; two "tabs" here are two MutationPersistence instances in sibling
     * injectors sharing one DB, one lock manager, and one broadcast hub.
     */
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
          next.grant(); // acquires synchronously — no double-grant window
        }
      };
      /** Take the lock NOW (caller checked compatibility); returns the releaser. */
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

    /** In-memory BroadcastChannel hub: every connected channel hears the others. */
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

    /** Root TestBed carries the shared infra (http, cache); each tab shadows the rest. */
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
          shared.db, // the SAME provider instance → the same underlying store
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

    /** Drain the grant → refresh → replay microtask chains + any scheduled effects. */
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
      await settle(); // give tab B every chance to (wrongly) replay too

      expect(bodies).toEqual([{ n: 7 }]); // exactly one send, from the holder
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
      tabA.online.set(false); // holds the lock, replays nothing — the row stays put
      makeResource(tabA, bodies);
      const tabB = makeTab(shared);
      makeResource(tabB, bodies);
      await settle();

      tabB.persistence.flush('update'); // online, has a live resource — but no lock
      await settle();
      expect(bodies).toEqual([]);
      expect(tabB.persistence.rowsFor('update').length).toBe(1); // untouched
    });

    it('a closing holder hands over: the next tab re-syncs and replays leftovers', async () => {
      const shared = configureShared({
        rows: [{ key: 'update', raw: stashed({ n: 7 }) }],
      });
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared);
      tabA.online.set(false); // grabs the lock but can't replay — the row survives it
      makeResource(tabA, bodies);
      const tabB = makeTab(shared);
      makeResource(tabB, bodies, { onSettled: () => settled.resolve() });
      await settle();
      expect(bodies).toEqual([]); // A offline, B gated — nothing moved

      tabA.injector.destroy(); // "the tab closed": DestroyRef releases the claim + lock

      await settled.promise;
      expect(bodies).toEqual([{ n: 7 }]); // B took over and replayed the leftover row
      expect(tabB.persistence.holdsReplayLock('update')).toBe(true);
      expect(tabB.persistence.rowsFor('update')).toEqual([]);
    });

    it('takeover does not resurrect rows the previous holder already settled', async () => {
      // sync disabled: the takeover re-sync ALONE must prevent resurrection (the
      // broadcast remove would otherwise clear B's mirror first and mask a refresh bug)
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

      // A holds the lock but is offline; B hydrates the same rows into its mirror
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
      expect(tabB.persistence.rowsFor('update').length).toBe(2); // B sees them…

      tabA.online.set(true); // regain → the holder replays and settles both
      await settle();
      await bothSettled.promise;
      expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);

      tabA.injector.destroy(); // …but takeover re-syncs from the DB: they're gone
      await settle();

      expect(bodies).toEqual([{ n: 1 }, { n: 2 }]); // nothing re-sent
      expect(tabB.persistence.holdsReplayLock('update')).toBe(true);
      expect(tabB.persistence.rowsFor('update')).toEqual([]); // mirror re-synced
    });

    it('a re-sync never drops rows this session stashed (IDB write still in flight)', async () => {
      configure();
      // a DB whose writes can be held back — the asynchronous IDB write window, for real
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
      tabA.online.set(false); // inert holder
      makeResource(tabA, bodies);

      const tabB = makeTab(shared);
      tabB.online.set(false);
      const resB = makeResource(tabB, bodies, { queue: true });
      await settle();

      holdWrites = true;
      resB.mutate({ n: 42 }); // stashed in B's mirror; the disk write hangs
      expect(tabB.persistence.rowsFor('update').length).toBe(1);

      tabA.injector.destroy(); // B takes over → refresh reads a disk WITHOUT the row
      await settle();

      // the local row survived the re-sync — it is not "settled elsewhere", just unwritten
      expect(tabB.persistence.rowsFor('update').length).toBe(1);
      for (const write of heldWrites.splice(0)) write();
    });

    it("a sibling's stash shows in pending live, is never replayed here, and clears on its settle", async () => {
      const shared = configureShared();
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared); // first in → key-lock holder
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

      resB.mutate({ n: 5 }); // stashed in B → announced to A
      expect(pendingA.count()).toBe(1); // THE staleness fix: A's badge is live

      // A holds the key lock and is online — but the row's owner is alive, so a
      // forced replay attempt in A must not touch it (B sends it itself)
      pendingA.flush('update');
      await settle();
      expect(bodies).toEqual([]);
      expect(tabA.persistence.rowsFor('update')).toEqual([]); // not in A's replay feed

      tabB.online.set(true); // B's own in-session queue delivers it…
      await settle();
      await settled.promise;
      expect(bodies).toEqual([{ n: 5 }]); // …exactly once
      expect(pendingA.count()).toBe(0); // …and A's badge cleared live
    });

    it("a dying sibling's announced rows replay here the moment it dies (death-watch)", async () => {
      const shared = configureShared();
      const bodies: unknown[] = [];
      const settled = Promise.withResolvers<void>();

      const tabA = makeTab(shared); // holder, online
      makeResource(tabA, bodies, { onSettled: () => settled.resolve() });
      const pendingA = runInInjectionContext(tabA.injector, () =>
        injectPendingMutations(),
      );
      const tabB = makeTab(shared);
      tabB.online.set(false);
      const resB = makeResource(tabB, bodies, { queue: true });
      await settle();

      resB.mutate({ n: 9 }); // B's row: visible in A, held back while B lives
      await settle();
      expect(bodies).toEqual([]);
      expect(pendingA.count()).toBe(1);

      tabB.injector.destroy(); // B dies with the row unsent — its session lock releases

      await settled.promise;
      expect(bodies).toEqual([{ n: 9 }]); // A's death-watch upgraded + replayed it
      expect(pendingA.count()).toBe(0);
    });

    it('hydrated disk rows written by a still-living tab are held back until it dies', async () => {
      // the owner is "alive elsewhere": its session lock is held externally
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

      expect(pendingA.count()).toBe(1); // visible…
      expect(tabA.persistence.rowsFor('update')).toEqual([]); // …but not replayable
      expect(bodies).toEqual([]);

      releaseOwner(); // the owner dies → A's death-watch fires
      await settled.promise;
      expect(bodies).toEqual([{ n: 3 }]);
      expect(pendingA.count()).toBe(0);
    });
  });
});
