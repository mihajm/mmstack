import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createTransitionScope, until } from '@mmstack/primitives';
import { queryResource } from './query-resource';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideMockQueryCache,
  ResourceSensors,
} from './util';

describe('cancellation contract', () => {
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
        provideHttpClient(
          withInterceptors([
            createCacheInterceptor(),
            createDedupeRequestsInterceptor(),
          ]),
        ),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  const make = (url: string, opt?: { cache?: boolean }) =>
    TestBed.runInInjectionContext(() =>
      queryResource<{ v: number }>(() => url, {
        cache: opt?.cache ? { staleTime: 10_000 } : undefined,
      }),
    );

  it('abort() cancels the in-flight reload, keeps the value, and never wedges', async () => {
    const res = make('/api/thing');
    TestBed.tick();
    http.expectOne('/api/thing').flush({ v: 1 });
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v !== undefined),
    );
    expect(res.value()).toEqual({ v: 1 });

    res.reload();
    TestBed.tick();
    const second = http.expectOne('/api/thing');
    expect(res.status()).toBe('reloading');

    res.abort();
    expect(second.cancelled).toBe(true);
    expect(res.value()).toEqual({ v: 1 });
    expect(res.status()).toBe('local');
    expect(res.isLoading()).toBe(false);

    res.abort();
    http.expectNone('/api/thing');

    res.reload();
    TestBed.tick();
    http.expectOne('/api/thing').flush({ v: 2 });
    await TestBed.runInInjectionContext(() =>
      until(res.value, (v) => v?.v === 2),
    );
    expect(res.value()).toEqual({ v: 2 });
  });

  it('a settled response populates the cache (the control for the abort case)', () => {
    const first = make('/api/cached', { cache: true });
    TestBed.tick();
    http.expectOne('/api/cached').flush({ v: 1 });
    expect(first.value()).toEqual({ v: 1 });

    const second = make('/api/cached', { cache: true });
    TestBed.tick();
    http.expectNone('/api/cached');
    expect(second.value()).toEqual({ v: 1 });
  });

  it('an aborted request never settles into the cache', () => {
    const first = make('/api/aborted', { cache: true });
    TestBed.tick();
    const req = http.expectOne('/api/aborted');

    first.abort();
    expect(req.cancelled).toBe(true);
    expect(first.hasValue()).toBe(false);

    const second = make('/api/aborted', { cache: true });
    TestBed.tick();
    http.expectOne('/api/aborted').flush({ v: 2 });
    expect(second.value()).toEqual({ v: 2 });
  });

  it('destroy mid-flight aborts the request and leaves the cache empty (the supersede path)', () => {
    const doomed = make('/api/superseded', { cache: true });
    TestBed.tick();
    const req = http.expectOne('/api/superseded');

    doomed.destroy();
    expect(req.cancelled).toBe(true);

    const successor = make('/api/superseded', { cache: true });
    TestBed.tick();
    http.expectOne('/api/superseded').flush({ v: 3 });
    expect(successor.value()).toEqual({ v: 3 });
  });

  it('scope.abortPending() aborts registered in-flight queries (shared-scope lever)', () => {
    const scope = TestBed.runInInjectionContext(() => createTransitionScope());
    const res = make('/api/scoped');
    scope.add(res);
    TestBed.tick();
    const req = http.expectOne('/api/scoped');
    expect(scope.pending()).toBe(true);

    expect(scope.abortPending()).toBe(1);
    expect(req.cancelled).toBe(true);
    expect(scope.pending()).toBe(false);

    expect(scope.abortPending()).toBe(0);
  });
});
