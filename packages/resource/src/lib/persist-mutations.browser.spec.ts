import {
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { mutationResource } from './mutation-resource';
import { injectPendingMutations, provideQueryCache } from './util';
import {
  MUTATION_PERSISTENCE_DB,
  MUTATION_SYNC,
  MutationPersistence,
} from './util/persist-mutations';
import { ResourceSensors } from './util/sensors';
import { createServer, type Server } from './util/testing/persist-harness';

// Mutation persistence on the browser's own IndexedDB, Web Locks and BroadcastChannel.
// Each "app" is an environment injector with its own registry, network and HTTP backend,
// sharing the page's storage and locks the way two tabs of one origin do. Destroying an
// app is a tab closing: its locks release and its stashes stay on disk.

const apps: EnvironmentInjector[] = [];

function openApp(server: Server, opts: { online?: boolean } = {}) {
  const online = signal(opts.online ?? true);
  const injector = createEnvironmentInjector(
    [
      MutationPersistence,
      {
        provide: MUTATION_SYNC,
        useFactory: () => new BroadcastChannel('mmstack-mutation-queue-sync'),
      },
      { provide: ResourceSensors, useValue: { networkStatus: online } },
      provideHttpClient(
        withNoXsrfProtection(),
        withInterceptors([server.interceptor]),
      ),
    ],
    TestBed.inject(EnvironmentInjector),
  );
  const app = runInInjectionContext(injector, () => ({
    injector,
    online,
    persistence: injector.get(MutationPersistence),
    pending: injectPendingMutations(),
    save: mutationResource(
      (body: { text: string }) => ({ url: '/api/notes', method: 'POST', body }),
      { queue: true, persist: { key: 'browser-note' } },
    ),
  }));
  apps.push(injector);
  return app;
}

const close = (app: { injector: EnvironmentInjector }) =>
  app.injector.destroy();

const texts = (server: Server) =>
  server.calls.map((c) => (c.body as { text: string }).text);

async function diskRows(): Promise<number> {
  const db = await TestBed.inject(MUTATION_PERSISTENCE_DB);
  return (await db.getAll()).length;
}

async function wipeDisk(): Promise<void> {
  const db = await TestBed.inject(MUTATION_PERSISTENCE_DB);
  for (const row of await db.getAll()) await db.remove(row.key);
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    TestBed.tick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never held');
}

async function quiet(ms = 150) {
  for (let t = 0; t < ms; t += 10) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('mutation persistence in a real browser', () => {
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideQueryCache()] });
    await wipeDisk();
  });
  afterEach(async () => {
    for (const injector of apps.splice(0))
      if (!injector.destroyed) injector.destroy();
    await wipeDisk();
  });

  it('online saves flow straight through and leave nothing on disk', async () => {
    const server = createServer();
    const app = openApp(server);
    await app.persistence.whenHydrated;

    app.save.mutate({ text: 'hello' });
    expect(app.pending.count()).toBe(1);

    await until(() => app.pending.count() === 0);
    expect(texts(server)).toEqual(['hello']);
    await until(async () => (await diskRows()) === 0);
  });

  it('stashes offline on disk, survives the app closing, and replays FIFO in the next one', async () => {
    const first = openApp(createServer(), { online: false });
    await first.persistence.whenHydrated;
    first.save.mutate({ text: 'first' });
    first.save.mutate({ text: 'second' });
    expect(first.pending.count()).toBe(2);
    await until(async () => (await diskRows()) === 2);
    close(first);

    const server = createServer();
    server.respond(null);
    const next = openApp(server);
    await next.persistence.whenHydrated;
    expect(next.pending.count()).toBe(2);

    for (let sent = 0; sent < 2; sent++) {
      await until(() => server.calls.length > sent);
      server.calls[sent].ok();
    }
    await until(() => next.pending.count() === 0);
    expect(texts(server)).toEqual(['first', 'second']);
    await until(async () => (await diskRows()) === 0);
  });

  it('two tabs: only the lock holder sends; a closing holder hands over its row', async () => {
    const serverA = createServer();
    serverA.respond(null);
    const tabA = openApp(serverA, { online: false });
    await tabA.persistence.whenHydrated;
    tabA.save.mutate({ text: 'solo' });
    await until(async () => (await diskRows()) === 1);
    tabA.online.set(true);
    await until(() => serverA.calls.length === 1);

    const serverB = createServer();
    const tabB = openApp(serverB);
    await tabB.persistence.whenHydrated;
    await until(() => tabB.pending.count() === 1);
    await quiet();
    expect(serverB.calls).toEqual([]);

    close(tabA);
    await until(() => serverB.calls.length === 1);
    expect(texts(serverB)).toEqual(['solo']);
    await until(() => tabB.pending.count() === 0);
    await until(async () => (await diskRows()) === 0);
    expect(texts(serverA)).toEqual(['solo']);
  });

  it('two live tabs: a stash shows in the sibling at once and only its owner sends it', async () => {
    const serverB = createServer();
    const holder = openApp(serverB);
    await holder.persistence.whenHydrated;
    const serverA = createServer();
    const owner = openApp(serverA, { online: false });
    await owner.persistence.whenHydrated;

    owner.save.mutate({ text: 'mine' });
    expect(owner.pending.count()).toBe(1);
    await until(() => holder.pending.count() === 1);

    owner.online.set(true);
    await until(() => owner.pending.count() === 0);
    await until(() => holder.pending.count() === 0);
    expect(texts(serverA)).toEqual(['mine']);
    expect(serverB.calls).toEqual([]);
    await until(async () => (await diskRows()) === 0);
  });
});
