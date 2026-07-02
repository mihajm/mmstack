import { provideLocationMocks } from '@angular/common/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PreloadRequester } from '../preloading/preload-requester';
import { createRouteData, provideRouteData, routeDataKey } from './route-data';
import { RouteDataPrefetcher, withRouteData } from './with-route-data';

// eslint-disable-next-line @angular-eslint/component-selector
@Component({ selector: 'blank-cmp', template: `` })
class Blank {}

type Captured = {
  params: Record<string, string>;
  query: Record<string, string>;
  isPrefetch: boolean;
};

function setup() {
  const calls: Captured[] = [];
  const KEY = routeDataKey<{ ok: true }>('user');
  const QKEY = routeDataKey<{ ok: true }>('list');

  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'users/:id',
          component: Blank,
          providers: [provideRouteData(KEY)],
          resolve: {
            user: createRouteData(KEY, (ctx) => {
              calls.push({
                params: ctx.params(),
                query: ctx.queryParams(),
                isPrefetch: ctx.isPrefetch,
              });
              return { ok: true } as const;
            }),
          },
        },
        {
          path: 'list',
          component: Blank,
          providers: [provideRouteData(QKEY)],
          resolve: {
            list: createRouteData(QKEY, (ctx) => {
              calls.push({
                params: ctx.params(),
                query: ctx.queryParams(),
                isPrefetch: ctx.isPrefetch,
              });
              return { ok: true } as const;
            }),
          },
        },
      ]),
      provideLocationMocks(),
      withRouteData(),
    ],
  });

  TestBed.inject(RouteDataPrefetcher).connect();
  const req = TestBed.inject(PreloadRequester);
  return { calls, req };
}

const tick = () => Promise.resolve();

describe('withRouteData (mmLink data prefetch)', () => {
  it('runs the matching route factory with URL params and isPrefetch=true', async () => {
    const { calls, req } = setup();

    req.startPreload('/users/42');
    await tick();

    expect(calls).toEqual([
      { params: { id: '42' }, query: {}, isPrefetch: true },
    ]);
  });

  it('parses query params from the hovered URL', async () => {
    const { calls, req } = setup();

    req.startPreload('/list?tab=open');
    await tick();

    expect(calls).toEqual([
      { params: {}, query: { tab: 'open' }, isPrefetch: true },
    ]);
  });

  it('dedupes repeated hovers of the same link', async () => {
    const { calls, req } = setup();

    req.startPreload('/users/7');
    req.startPreload('/users/7');
    await tick();

    expect(calls).toHaveLength(1);
  });

  it('does not run when the hovered URL matches no route-data route', async () => {
    const { calls, req } = setup();

    req.startPreload('/nope/123');
    await tick();

    expect(calls).toHaveLength(0);
  });

  it('warms different params independently', async () => {
    const { calls, req } = setup();

    req.startPreload('/users/1');
    req.startPreload('/users/2');
    await tick();

    expect(calls.map((c) => c.params['id'])).toEqual(['1', '2']);
  });
});

// ——— failure paths: a throwing/erroring warm must never wedge the pipeline ———

function failureSetup(
  factory: (ctx: { isPrefetch: boolean }) => unknown,
  other?: () => void,
) {
  const KEY = routeDataKey<unknown>('fragile');
  const OTHER = routeDataKey<{ ok: true }>('other');
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'fragile/:id',
          component: Blank,
          providers: [provideRouteData(KEY)],
          resolve: { fragile: createRouteData(KEY, factory) },
        },
        {
          path: 'other',
          component: Blank,
          providers: [provideRouteData(OTHER)],
          resolve: {
            other: createRouteData(OTHER, () => {
              other?.();
              return { ok: true } as const;
            }),
          },
        },
      ]),
      provideLocationMocks(),
      withRouteData(),
    ],
  });
  TestBed.inject(RouteDataPrefetcher).connect();
  return TestBed.inject(PreloadRequester);
}

describe('withRouteData — failure paths', () => {
  it('a throwing factory does not kill the pipeline, and the same link can retry', async () => {
    let attempts = 0;
    let otherRuns = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = failureSetup(
      () => {
        attempts++;
        throw new Error('boom');
      },
      () => otherRuns++,
    );

    req.startPreload('/fragile/1');
    await tick();
    expect(attempts).toBe(1);

    req.startPreload('/other'); // the subscription must still be alive
    await tick();
    expect(otherRuns).toBe(1);

    req.startPreload('/fragile/1'); // a failed warm is retryable
    await tick();
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an error-settled warm clears the dedupe so the next hover retries', async () => {
    let attempts = 0;
    const status = signal('loading');
    const req = failureSetup(() => {
      attempts++;
      return { status };
    });

    req.startPreload('/fragile/2');
    await tick();
    expect(attempts).toBe(1);

    status.set('error');
    await tick();
    TestBed.tick(); // flush the settle effect

    req.startPreload('/fragile/2');
    await tick();
    expect(attempts).toBe(2);
  });

  it('a resolved warm stays deduped', async () => {
    let attempts = 0;
    const status = signal('loading');
    const req = failureSetup(() => {
      attempts++;
      return { status };
    });

    req.startPreload('/fragile/3');
    await tick();
    status.set('resolved');
    await tick();
    TestBed.tick();

    req.startPreload('/fragile/3');
    await tick();
    expect(attempts).toBe(1);
  });

  it('watches every resource of a composite return (an erroring member re-arms the hover)', async () => {
    let attempts = 0;
    const a = signal('loading');
    const b = signal('loading');
    const req = failureSetup(() => {
      attempts++;
      return { a: { status: a }, b: { status: b } };
    });

    req.startPreload('/fragile/4');
    await tick();

    a.set('resolved');
    await tick();
    TestBed.tick();
    req.startPreload('/fragile/4'); // still in flight (b loading) → deduped
    await tick();
    expect(attempts).toBe(1);

    b.set('error');
    await tick();
    TestBed.tick();
    req.startPreload('/fragile/4'); // the composite settled with an error → retry
    await tick();
    expect(attempts).toBe(2);
  });
});
