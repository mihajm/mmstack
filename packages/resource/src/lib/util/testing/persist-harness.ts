import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpRequest,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  type Provider,
  runInInjectionContext,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import {
  mutationResource,
  type MutationResourceOptions,
} from '../../mutation-resource';
import { provideQueryCache } from '../cache';
import {
  MUTATION_PERSISTENCE_DB,
  MUTATION_REPLAY_LOCKS,
  MUTATION_SYNC,
  MutationPersistence,
  provideMockMutationPersistence,
} from '../persist-mutations';
import { ResourceSensors } from '../sensors';
import type { createFakeChannelHub } from './fake-locks';

/** One request seen by the {@link server}; answer it with `ok` or `fail`. */
export type Call = {
  readonly url: string;
  readonly body: unknown;
  readonly res: Subject<HttpEvent<unknown>>;
  ok(body?: unknown): void;
  fail(): void;
};

/**
 * An HTTP backend that records every request and leaves it open. With `auto` set it answers
 * at once (`'ok'` or `'fail'`), as a server that never hangs.
 */
export function createServer() {
  const calls: Call[] = [];
  let auto: 'ok' | 'fail' | null = 'ok';
  const interceptor = (req: HttpRequest<unknown>) => {
    const res = new Subject<HttpEvent<unknown>>();
    const call: Call = {
      url: req.url,
      body: req.body,
      res,
      ok: (body = { ok: true }) => {
        res.next(new HttpResponse({ body, status: 200 }));
        res.complete();
      },
      fail: () =>
        res.error(new HttpErrorResponse({ error: 'nope', status: 500 })),
    };
    calls.push(call);
    if (auto === 'ok') queueMicrotask(() => call.ok());
    if (auto === 'fail') queueMicrotask(() => call.fail());
    return res;
  };
  return {
    calls,
    bodies: () => calls.map((c) => c.body),
    respond: (mode: 'ok' | 'fail' | null) => (auto = mode),
    interceptor,
  };
}

export type Server = ReturnType<typeof createServer>;

export const stashed = (mutation: unknown, ictx?: unknown) => ({
  mutation,
  ctx: ictx,
});

/** Lets microtasks, effects and zero-delay timers run until the graph is quiet. */
export async function settle(rounds = 4): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    TestBed.tick();
    await new Promise((res) => setTimeout(res));
    TestBed.tick();
  }
}

/** Root TestBed setup: a browser platform, no cross-tab sync, a writable network signal. */
export function configureRoot(opts: {
  server: Server;
  persistence?: Provider;
  /** `'platform'` keeps the default `navigator.locks` lookup. */
  locks?: LockManager | null | 'platform';
  extra?: Provider[];
}): WritableSignal<boolean> {
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideQueryCache(),
      opts.persistence ?? provideMockMutationPersistence(),
      { provide: MUTATION_SYNC, useValue: null },
      ...(opts.locks === 'platform'
        ? []
        : [{ provide: MUTATION_REPLAY_LOCKS, useValue: opts.locks ?? null }]),
      { provide: ResourceSensors, useValue: { networkStatus: online } },
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([opts.server.interceptor]),
      ),
      ...(opts.extra ?? []),
    ],
  });
  return online;
}

export type SharedInfra = {
  readonly db: Provider;
  readonly locks: LockManager | null;
  readonly hub?: ReturnType<typeof createFakeChannelHub>;
};

/** A second app on the same origin: its own registry, network and channel end. */
export type Tab = {
  readonly injector: EnvironmentInjector;
  readonly online: WritableSignal<boolean>;
  readonly persistence: MutationPersistence;
};

export function makeTab(shared: SharedInfra, inheritLocks = false): Tab {
  const online = signal(true);
  const injector = createEnvironmentInjector(
    [
      MutationPersistence,
      shared.db,
      ...(inheritLocks
        ? []
        : [{ provide: MUTATION_REPLAY_LOCKS, useValue: shared.locks }]),
      { provide: MUTATION_SYNC, useValue: shared.hub?.connect() ?? null },
      { provide: ResourceSensors, useValue: { networkStatus: online } },
    ],
    TestBed.inject(EnvironmentInjector),
  );
  return { injector, online, persistence: injector.get(MutationPersistence) };
}

/** A persisted `mutationResource` posting `{ n }` bodies, created in `injector`. */
export function persistedResource(
  injector: EnvironmentInjector,
  opts: Partial<
    MutationResourceOptions<unknown, unknown, { n: number }, unknown>
  > & { key?: string } = {},
) {
  const { key = 'update', persist, ...rest } = opts;
  return runInInjectionContext(injector, () =>
    mutationResource<unknown, unknown, { n: number }, unknown>(
      (body) => ({ url: `https://x.test/${key}`, method: 'POST', body }),
      { persist: { key, ...persist }, ...rest },
    ),
  );
}

/** A plain in-memory DB with full control over what `getAll` returns. */
export function createMemoryDB(order: (rows: any[]) => any[] = (rows) => rows) {
  const map = new Map<string, any>();
  const db = {
    getAll: async () => order(Array.from(map.values())),
    store: async (entry: any) => {
      map.set(entry.key, entry);
    },
    remove: async (key: string) => {
      map.delete(key);
    },
  };
  return {
    map,
    db,
    provider: {
      provide: MUTATION_PERSISTENCE_DB,
      useValue: Promise.resolve(db),
    } as Provider,
  };
}
