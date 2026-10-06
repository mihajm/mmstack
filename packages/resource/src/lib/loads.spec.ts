import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createAttributedPending,
  createTransitionScope,
} from '@mmstack/primitives';
import { mutationResource } from './mutation-resource';
import { queryResource } from './query-resource';
import { streamResource } from './stream-resource';
import { provideMockQueryCache, ResourceSensors } from './util';

describe('loads: the flight counter on resource refs', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideMockQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
  };

  it('query: moves with status, on read, for a new request, an abort+restart and a reload; abort does not move it', async () => {
    const url = signal<string | undefined>(undefined);
    const q = TestBed.runInInjectionContext(() =>
      queryResource<number>(() => url()),
    );
    expect(q.loads()).toBe(0);

    url.set('/a');
    expect([q.status(), q.loads()]).toEqual(['loading', 1]); // no effect flush needed
    url.set('/b'); // replaces the load in flight; status never leaves loading
    expect([q.status(), q.loads()]).toEqual(['loading', 2]);
    TestBed.tick();
    http.match('/a').forEach((r) => r.flush(1));
    http.expectOne('/b').flush(2);
    await settle();
    expect([q.status(), q.loads()]).toEqual(['resolved', 2]);

    expect(q.reload()).toBe(true);
    expect([q.status(), q.loads()]).toEqual(['reloading', 3]);
    q.abort();
    expect(q.loads()).toBe(3);
    q.destroy();
  });

  it('July pins on a real query: abort+restart and settle+refire are the transaction own work', async () => {
    const url = signal('/a');
    const { scope, q } = TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const q = queryResource<number>(() => url());
      scope.add(q, { suspends: false });
      return { scope, q };
    });
    expect(q.status()).toBe('loading'); // in flight before the transaction

    const restart = createAttributedPending(scope);
    expect(restart()).toBe(false); // pre-existing, not ours
    url.set('/b'); // the transaction's write changes the request mid-flight
    expect(restart()).toBe(true);

    TestBed.tick();
    http.match(() => true).forEach((r) => r.flush(1));
    await settle();
    url.set('/c');
    TestBed.tick();
    const refire = createAttributedPending(scope);
    expect(refire()).toBe(false);
    http.expectOne('/c').flush(3); // settles...
    await settle();
    q.reload(); // ...and refires before the next read
    expect(refire()).toBe(true);
    q.destroy();
  });

  it('mutation: each mutate starts a counted load', () => {
    const m = TestBed.runInInjectionContext(() =>
      mutationResource((v: number) => ({ url: '/m', method: 'POST', body: v })),
    );
    const before = m.loads();
    m.mutate(1);
    expect(m.loads()).toBe(before + 1);
    m.destroy();
  });

  it('stream: a new source counts, an accepted reload counts', () => {
    const src = signal<string | undefined>(undefined);
    const s = TestBed.runInInjectionContext(() =>
      streamResource<number>(() => src(), {
        transport: () => ({ close: () => undefined }),
      }),
    );
    expect(s.loads()).toBe(0);
    src.set('ws://a');
    expect(s.loads()).toBe(1);
    src.set('ws://b');
    expect(s.loads()).toBe(2);
    s.destroy();
  });
});
