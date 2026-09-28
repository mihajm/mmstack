import {
  provideHttpClient,
  withInterceptors,
  type HttpResourceRequest,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { PLATFORM_ID, signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { manualQueryResource } from './manual-query';
import {
  type FlightEdge,
  provideQueryResourceOptions,
  queryResource,
  type QueryResourceOptions,
} from './query-resource';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideMockQueryCache,
  ResourceSensors,
} from './util';

type Value = { v: number };

describe('queryResource onFlight', () => {
  let http: HttpTestingController;
  let edges: string[];
  const record = (e: FlightEdge) => edges.push(`${e.phase} ${e.generation}`);

  const setup = (providers: Provider[] = []) => {
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
        provideHttpClient(
          withInterceptors([
            createCacheInterceptor(),
            createDedupeRequestsInterceptor(),
          ]),
        ),
        provideHttpClientTesting(),
        ...providers,
      ],
    });
    http = TestBed.inject(HttpTestingController);
  };

  const make = (
    request: () => string | HttpResourceRequest | undefined,
    opt?: QueryResourceOptions<Value>,
  ) =>
    TestBed.runInInjectionContext(() =>
      queryResource<Value>(request, { onFlight: record, ...opt }),
    );

  /** Lets the loader promise settle, then flushes effects. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const fail = (url: string) =>
    http
      .expectOne(url)
      .flush('boom', { status: 500, statusText: 'Server Error' });

  beforeEach(() => {
    edges = [];
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  it('a single fetch that resolves: start, landed', async () => {
    setup();
    const res = make(() => '/api/one');
    TestBed.tick();
    expect(edges).toEqual(['start 1']);

    http.expectOne('/api/one').flush({ v: 1 });
    await settle();
    expect(res.value()).toEqual({ v: 1 });
    expect(edges).toEqual(['start 1', 'landed 1']);
  });

  it('retries belong to their generation; only the final failure closes it', async () => {
    setup();
    const onError = vi.fn();
    const res = make(() => '/api/fail', {
      retry: { max: 2, backoff: 1 },
      onError,
    });
    TestBed.tick();

    for (let attempt = 0; attempt < 3; attempt++) {
      fail('/api/fail');
      await settle();
      if (attempt < 2) {
        expect(edges).toEqual(['start 1']);
        await wait(10);
        TestBed.tick();
        expect(edges).toEqual(['start 1']);
      }
    }

    expect(res.status()).toBe('error');
    expect(edges).toEqual(['start 1', 'failed 1']);
    expect(onError.mock.calls.map((c) => c[2])).toEqual([false, false, true]);
  });

  it('a retry that succeeds lands the same generation', async () => {
    setup();
    make(() => '/api/flaky', { retry: { max: 2, backoff: 1 } });
    TestBed.tick();
    fail('/api/flaky');
    await settle();
    await wait(10);
    TestBed.tick();
    http.expectOne('/api/flaky').flush({ v: 1 });
    await settle();
    expect(edges).toEqual(['start 1', 'landed 1']);
  });

  it('a request change while loading supersedes the open generation first', async () => {
    setup();
    const url = signal('/api/a');
    const res = make(() => url());
    TestBed.tick();
    const first = http.expectOne('/api/a');

    url.set('/api/b');
    TestBed.tick();
    expect(first.cancelled).toBe(true);
    expect(edges).toEqual(['start 1', 'superseded 1', 'start 2']);

    http.expectOne('/api/b').flush({ v: 2 });
    await settle();
    expect(res.value()).toEqual({ v: 2 });
    expect(edges).toEqual(['start 1', 'superseded 1', 'start 2', 'landed 2']);
  });

  it('reload() while loading is a no-op, so the generation is not superseded', async () => {
    setup();
    const res = make(() => '/api/reload');
    TestBed.tick();
    const first = http.expectOne('/api/reload');

    expect(res.reload()).toBe(false);
    TestBed.tick();
    http.expectNone('/api/reload');
    expect(first.cancelled).toBe(false);

    first.flush({ v: 1 });
    await settle();
    expect(edges).toEqual(['start 1', 'landed 1']);

    expect(res.reload()).toBe(true);
    TestBed.tick();
    http.expectOne('/api/reload').flush({ v: 2 });
    await settle();
    expect(edges).toEqual(['start 1', 'landed 1', 'start 2', 'landed 2']);
  });

  it('abort() while loading closes the generation; a later reload starts the next', async () => {
    setup();
    const res = make(() => '/api/abort');
    TestBed.tick();
    const first = http.expectOne('/api/abort');

    res.abort();
    expect(first.cancelled).toBe(true);
    TestBed.tick();
    expect(edges).toEqual(['start 1', 'aborted 1']);

    res.reload();
    TestBed.tick();
    http.expectOne('/api/abort').flush({ v: 2 });
    await settle();
    expect(edges).toEqual(['start 1', 'aborted 1', 'start 2', 'landed 2']);
  });

  it('a disabled request or destroy() mid-flight aborts the open generation', async () => {
    setup();
    const url = signal<string | undefined>('/api/gone');
    const res = make(() => url());
    TestBed.tick();
    http.expectOne('/api/gone');

    url.set(undefined);
    TestBed.tick();
    expect(edges).toEqual(['start 1', 'aborted 1']);

    url.set('/api/back');
    TestBed.tick();
    http.expectOne('/api/back');
    res.destroy();
    expect(edges).toEqual(['start 1', 'aborted 1', 'start 2', 'aborted 2']);
  });

  it('a value write mid-flight aborts the generation', async () => {
    setup();
    const res = make(() => '/api/write');
    TestBed.tick();
    const first = http.expectOne('/api/write');
    res.set({ v: 9 });
    expect(first.cancelled).toBe(true);
    TestBed.tick();
    expect(edges).toEqual(['start 1', 'aborted 1']);
  });

  it('refresh ticks start new generations', async () => {
    setup();
    make(() => '/api/poll', { refresh: 20 });
    TestBed.tick();
    http.expectOne('/api/poll').flush({ v: 1 });
    await settle();
    await wait(30);
    TestBed.tick();
    http.expectOne('/api/poll').flush({ v: 2 });
    await settle();
    expect(edges.slice(0, 4)).toEqual([
      'start 1',
      'landed 1',
      'start 2',
      'landed 2',
    ]);
  });

  it('a paused resource holding its value emits nothing', async () => {
    setup();
    const paused = signal(false);
    const id = signal(1);
    make(() => `/api/paused/${id()}`, { pause: paused });
    TestBed.tick();
    http.expectOne('/api/paused/1').flush({ v: 1 });
    await settle();
    expect(edges).toEqual(['start 1', 'landed 1']);

    paused.set(true);
    TestBed.tick();
    id.set(2);
    TestBed.tick();
    http.expectNone('/api/paused/2');
    expect(edges).toEqual(['start 1', 'landed 1']);
  });

  it('a fresh cache hit still runs the loader, so it is a flight served by the interceptor', async () => {
    setup();
    const cache = { staleTime: 10_000 };
    make(() => '/api/cached', { cache });
    TestBed.tick();
    http.expectOne('/api/cached').flush({ v: 1 });
    await settle();

    const other: string[] = [];
    const second = TestBed.runInInjectionContext(() =>
      queryResource<Value>(() => '/api/cached', {
        cache,
        onFlight: (e) => other.push(`${e.phase} ${e.generation}`),
      }),
    );
    TestBed.tick();
    http.expectNone('/api/cached');
    await settle();
    expect(second.value()).toEqual({ v: 1 });
    expect(other).toEqual(['start 1', 'landed 1']);
  });

  it('without onFlight the resource behaves as before', async () => {
    setup();
    const res = TestBed.runInInjectionContext(() =>
      queryResource<Value>(() => '/api/plain'),
    );
    TestBed.tick();
    http.expectOne('/api/plain').flush({ v: 1 });
    await settle();
    expect(res.value()).toEqual({ v: 1 });
    expect(edges).toEqual([]);
  });

  it('a throwing onFlight does not break the resource and logs in dev mode', async () => {
    setup();
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const thrown = new Error('observer bug');
    let calls = 0;
    const res = make(() => '/api/throws', {
      onFlight: () => {
        calls++;
        throw thrown;
      },
    });
    TestBed.tick();
    http.expectOne('/api/throws').flush({ v: 1 });
    await settle();

    expect(res.status()).toBe('resolved');
    expect(res.value()).toEqual({ v: 1 });
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledWith(
      '[@mmstack/resource]: onFlight threw',
      thrown,
    );
    error.mockRestore();
  });

  it('a default from provideQueryResourceOptions receives edges; a per-resource onFlight wins', async () => {
    const provided: string[] = [];
    setup([
      provideQueryResourceOptions({
        onFlight: (e) => provided.push(`${e.phase} ${e.generation}`),
      }),
    ]);

    TestBed.runInInjectionContext(() =>
      queryResource<Value>(() => '/api/provided'),
    );
    TestBed.tick();
    http.expectOne('/api/provided').flush({ v: 1 });
    await settle();
    expect(provided).toEqual(['start 1', 'landed 1']);

    make(() => '/api/own');
    TestBed.tick();
    http.expectOne('/api/own').flush({ v: 2 });
    await settle();
    expect(edges).toEqual(['start 1', 'landed 1']);
    expect(provided).toEqual(['start 1', 'landed 1']);
  });

  it('manual queries: trigger() is a flight; a second trigger while loading supersedes it', async () => {
    setup();
    const res = TestBed.runInInjectionContext(() =>
      manualQueryResource<Value>(() => '/api/manual', { onFlight: record }),
    );
    TestBed.tick();
    expect(edges).toEqual([]);

    const first = res.trigger();
    TestBed.tick();
    http.expectOne('/api/manual').flush({ v: 1 });
    await settle();
    await expect(first).resolves.toEqual({ v: 1 });
    expect(edges).toEqual(['start 1', 'landed 1']);

    edges = [];
    const second = res.trigger('/api/manual/a');
    TestBed.tick();
    const pendingA = http.expectOne('/api/manual/a');
    const third = res.trigger('/api/manual/b');
    TestBed.tick();
    expect(pendingA.cancelled).toBe(true);
    http.expectOne('/api/manual/b').flush({ v: 3 });
    await settle();
    await expect(second).resolves.toEqual({ v: 3 });
    await expect(third).resolves.toEqual({ v: 3 });
    expect(edges).toEqual(['start 2', 'superseded 2', 'start 3', 'landed 3']);
  });
});
