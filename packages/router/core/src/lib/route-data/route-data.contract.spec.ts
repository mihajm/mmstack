import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  ErrorHandler,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  createRouteData,
  injectRouteData,
  provideRouteData,
  type RouteDataContext,
  routeDataKey,
} from './route-data';

type Bearer = { status: WritableSignal<string>; error: () => unknown };
const bearer = (status: string): Bearer => ({
  status: signal(status),
  error: () => new Error('boom'),
});

const KEY = routeDataKey<unknown>('contract');

@Component({ selector: 'rd-page', template: `page` })
class Page {
  readonly data = injectRouteData(KEY);
}

async function setup(routes: Routes, url: string) {
  const errors: unknown[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      {
        provide: ErrorHandler,
        useValue: { handleError: (e: unknown) => errors.push(e) },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const ok = await TestBed.inject(Router).navigateByUrl(url);
  harness.detectChanges();
  return { harness, errors, ok, router: TestBed.inject(Router) };
}

const route = (
  factory: (ctx: RouteDataContext) => unknown,
  onError?: (e: unknown) => void,
): Routes => [
  {
    path: 'p',
    component: Page,
    providers: [provideRouteData(KEY)],
    resolve: {
      d: createRouteData(KEY, factory, onError ? { onError } : undefined),
    },
  },
];

describe('route data contract: context', () => {
  it('ctx.param is memoized per name and dev-errors once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let pair: Signal<string>[] = [];
    await setup(
      route((ctx) => (pair = [ctx.param('x'), ctx.param('x')])),
      '/p',
    );
    expect(pair[0]).toBe(pair[1]);
    pair[0]();
    pair[1]();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('isPrefetch is false on the live path', async () => {
    let seen: boolean | undefined;
    await setup(
      route((ctx) => (seen = ctx.isPrefetch)),
      '/p',
    );
    expect(seen).toBe(false);
  });

  it('query params stay live when keys are added or one of several changes', async () => {
    let q: Signal<Record<string, string>> | undefined;
    const s = await setup(
      route((ctx) => (q = ctx.queryParams)),
      '/p?tab=a',
    );
    expect(q?.()).toEqual({ tab: 'a' });
    await s.router.navigateByUrl('/p?tab=a&page=1');
    expect(q?.()['page']).toBe('1');
    await s.router.navigateByUrl('/p?tab=a&page=2');
    expect(q?.()['page']).toBe('2');
    await s.router.navigateByUrl('/p?tab=a');
    expect(q?.()).toEqual({ tab: 'a' });
  });
});

describe('route data contract: onError', () => {
  it('a factory returning null with onError navigates normally', async () => {
    const s = await setup(
      route(
        () => null,
        () => undefined,
      ),
      '/p',
    );
    expect(s.ok).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it('only status-bearing members of a composite are watched, each transition fires once', async () => {
    const a = bearer('resolved');
    const b = bearer('resolved');
    const onError = vi.fn();
    const s = await setup(
      route(() => ({ meta: 1, a, b }), onError),
      '/p',
    );
    a.status.set('error');
    TestBed.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    b.status.set('reloading');
    TestBed.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.errors).toEqual([]);
  });

  it('a bearer already in error when created fires once', async () => {
    const onError = vi.fn();
    await setup(
      route(() => bearer('error'), onError),
      '/p',
    );
    TestBed.tick();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('without onError an erroring resource reports nothing to the ErrorHandler', async () => {
    const a = bearer('resolved');
    const s = await setup(
      route(() => a),
      '/p',
    );
    a.status.set('error');
    TestBed.tick();
    expect(s.errors).toEqual([]);
  });
});

describe('route data contract: wiring', () => {
  it('reading data whose resolver is not wired throws', async () => {
    const s = await setup(
      [
        { path: 'p', component: Page, providers: [provideRouteData(KEY)] },
        { path: '**', children: [] },
      ],
      '/q',
    );
    await expect(s.router.navigateByUrl('/p')).rejects.toThrow();
  });
});
