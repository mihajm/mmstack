import {
  HttpErrorResponse,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpInterceptorFn,
} from '@angular/common/http';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  getTransitionScope,
  provideTransitionScope,
  until,
  type TransitionScope,
} from '@mmstack/primitives';
import { of, throwError } from 'rxjs';
import { infiniteQueryResource } from './infinite-query';
import { manualQueryResource } from './manual-query';
import { mutationResource } from './mutation-resource';
import { queryResource } from './query-resource';
import { streamResource, type StreamTransport } from './stream-resource';
import { provideQueryCache, ResourceSensors } from './util';

// Counts every request by URL; `/fail/...` answers 500, anything else `{ ok: true }`.
const hits = new Map<string, number>();
const interceptor: HttpInterceptorFn = (req) => {
  hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
  return req.url.includes('/fail/')
    ? throwError(() => new HttpErrorResponse({ error: 'x', status: 500 }))
    : of(new HttpResponse({ body: { ok: true }, status: 200 }));
};

describe('resource registration riders (retry reach, displayName)', () => {
  let boundary: EnvironmentInjector;
  let scope: TransitionScope;

  beforeEach(() => {
    hits.clear();
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: {
            networkStatus: signal(true),
            pageVisibility: signal<DocumentVisibilityState>('visible'),
          },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([interceptor]),
        ),
      ],
    });
    boundary = createEnvironmentInjector(
      [provideTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    scope = getTransitionScope(boundary) as TransitionScope;
  });

  afterEach(() => boundary.destroy());

  it('a failed named query shows its name in errored()', async () => {
    const res = queryResource<{ ok: boolean }>(
      () => 'https://example.com/fail/named',
      { register: 'suspend', displayName: 'orders', injector: boundary },
    );
    await until(res.status, (s) => s === 'error', { injector: boundary });
    expect(scope.errored()[0].failure.displayName).toBe('orders');
  });

  it('a named mutation registers under its name (it returns to idle after a failure, so the name is read off the census)', () => {
    mutationResource<{ ok: boolean }, { ok: boolean }, number>(
      (id) => ({ url: `https://example.com/mutate/${id}`, method: 'POST' }),
      { register: 'indicator', displayName: 'save', injector: boundary },
    );
    expect(scope.census.snapshot().map((m) => m.displayName)).toEqual(['save']);
  });

  it('a named stream registers under its name', () => {
    const transport: StreamTransport<{ n: number }> = () => ({
      close: () => undefined,
    });
    streamResource<{ n: number }>(() => 'wss://x/feed', {
      transport,
      register: 'indicator',
      displayName: 'ticker',
      injector: boundary,
    });
    expect(scope.census.snapshot().map((m) => m.displayName)).toEqual([
      'ticker',
    ]);
  });

  it('manualQueryResource: a failed registration is retried by retryAll() once, through its reload', async () => {
    const url = 'https://example.com/fail/manual';
    const res = manualQueryResource<{ ok: boolean }>(() => url, {
      register: 'suspend',
      displayName: 'search',
      injector: boundary,
    });
    await expect(res.trigger()).rejects.toBeDefined();
    expect(hits.get(url)).toBe(1);
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual([
      'search',
    ]);
    expect(scope.errored()[0].failure.message).toBeDefined();

    const round = scope.retryAll();
    expect(round.dispatched).toBe(1);
    await until(res.status, (s) => s === 'error', { injector: boundary });
    TestBed.tick();
    expect(hits.get(url)).toBe(2);
  });

  it('infiniteQueryResource: a failed registration is retried by retryAll() once, through its reload', async () => {
    const url = 'https://example.com/fail/pages';
    const res = infiniteQueryResource<{ ok: boolean }, { ok: boolean }, number>(
      () => url,
      {
        initialPageParam: 0,
        getNextPageParam: () => null,
        register: 'suspend',
        displayName: 'feed',
        injector: boundary,
      },
    );
    await until(res.status, (s) => s === 'error', { injector: boundary });
    expect(hits.get(url)).toBe(1);
    expect(scope.errored().map((e) => e.failure.displayName)).toEqual(['feed']);
    expect(scope.errored()[0].failure.message).toBeDefined();

    const round = scope.retryAll();
    expect(round.dispatched).toBe(1);
    await until(res.status, (s) => s === 'error', { injector: boundary });
    TestBed.tick();
    expect(hits.get(url)).toBe(2);
  });
});
