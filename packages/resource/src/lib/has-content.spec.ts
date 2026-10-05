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
import { queryResource } from './query-resource';
import { provideQueryCache, ResourceSensors } from './util';

// `/fail/...` answers 500, anything else answers `[{ ok: true }]`.
const interceptor: HttpInterceptorFn = (req) =>
  req.url.includes('/fail/')
    ? throwError(() => new HttpErrorResponse({ error: 'x', status: 500 }))
    : of(new HttpResponse({ body: [{ ok: true }], status: 200 }));

describe('queryResource hasContent', () => {
  let boundary: EnvironmentInjector;
  let scope: TransitionScope;

  beforeEach(() => {
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

  it('keepPrevious: a failed reload keeps content (hasValue false, hasContent true) and the boundary does not blank', async () => {
    const fail = signal(false);
    const res = queryResource<{ ok: boolean }[]>(
      () => `https://example.com/${fail() ? 'fail/' : ''}held`,
      { keepPrevious: true, register: 'suspend', injector: boundary },
    );
    await until(res.value, (v) => v !== undefined, { injector: boundary });
    expect(res.hasContent()).toBe(true);

    fail.set(true);
    await until(res.status, (s) => s === 'error', { injector: boundary });
    expect(res.hasValue()).toBe(false);
    expect(res.hasContent()).toBe(true);
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(false);
    expect(scope.errored().length).toBe(1);
  });

  it('a failed first load has no content: the boundary presents failed instead of suspending forever', async () => {
    const res = queryResource<{ ok: boolean }[]>(
      () => 'https://example.com/fail/first',
      { register: 'suspend', injector: boundary },
    );
    expect(scope.suspended('value')).toBe(true);
    await until(res.status, (s) => s === 'error', { injector: boundary });
    expect(res.hasContent()).toBe(false);
    expect(scope.suspended('value')).toBe(false);
    expect(scope.failed()).toBe(true);
  });
});
