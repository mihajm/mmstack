import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
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
