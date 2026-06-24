/* eslint-disable @angular-eslint/component-selector */
/**
 * Integration for `withRouteData()` data prefetch, driven by the real `PreloadRequester` signal
 * `mmLink` emits, with real `httpResource`. Covers: hover warms an eager route's data, dedupe,
 * non-match, and the two-phase behavior for lazily code-split (`loadChildren`) routes (the data
 * factory isn't discoverable until the chunk has loaded).
 */
import { provideLocationMocks } from '@angular/common/testing';
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { PreloadRequester } from '../preloading/preload-requester';
import {
  createRouteData,
  injectRouteData,
  provideRouteData,
  routeDataKey,
} from './route-data';
import { withRouteData } from './with-route-data';
import { TransitionRouterOutlet } from '../transition-router-outlet';

const USER = routeDataKey<ReturnType<typeof httpResource<string>>>('user');
const ITEM = routeDataKey<ReturnType<typeof httpResource<string>>>('item');

@Component({ selector: 'route-home', template: `home` })
class HomeCmp {}

@Component({ selector: 'route-user', template: `user:{{ data.value() ?? '...' }}` })
class UserCmp {
  readonly data = injectRouteData(USER);
}

@Component({ selector: 'route-item', template: `item:{{ data.value() ?? '...' }}` })
class ItemCmp {
  readonly data = injectRouteData(ITEM);
}

@Component({
  selector: 'pf-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

function routes() {
  return [
    { path: 'home', component: HomeCmp },
    {
      path: 'users/:id',
      component: UserCmp,
      providers: [provideRouteData(USER)],
      resolve: {
        user: createRouteData(USER, (ctx) => {
          const res = httpResource<string>(() => `/api/users/${ctx.params()['id']}`);
          registerResource(res, { suspends: true });
          return res;
        }),
      },
    },
    {
      path: 'lazy',
      loadChildren: () =>
        Promise.resolve([
          {
            path: 'item/:id',
            component: ItemCmp,
            providers: [provideRouteData(ITEM)],
            resolve: {
              item: createRouteData(ITEM, (ctx) => {
                const res = httpResource<string>(
                  () => `/api/items/${ctx.params()['id']}`,
                );
                registerResource(res, { suspends: true });
                return res;
              }),
            },
          },
        ]),
    },
  ];
}

async function setup() {
  const rendered = await render(Host, {
    providers: [
      provideRouter(routes()),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
      withRouteData(),
    ],
  });
  return {
    ...rendered,
    router: TestBed.inject(Router),
    http: TestBed.inject(HttpTestingController),
    preload: TestBed.inject(PreloadRequester),
  };
}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('prefetch integration (withRouteData + httpResource)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }));

  it('warms an eager route’s data on the preload signal', async () => {
    const { fixture, router, http, preload } = await setup();
    await router.navigateByUrl('/home');
    await flush(fixture);

    preload.startPreload('/users/4');
    await flush(fixture);

    http.expectOne('/api/users/4').flush('Four'); // request issued by prefetch, before nav
    await flush(fixture);
  });

  it('dedupes repeated hovers of the same link', async () => {
    const { fixture, router, http, preload } = await setup();
    await router.navigateByUrl('/home');
    await flush(fixture);

    preload.startPreload('/users/4');
    preload.startPreload('/users/4');
    await flush(fixture);

    http.expectOne('/api/users/4').flush('Four'); // exactly one — second hover deduped
    await flush(fixture);
  });

  it('does nothing for a path that matches no route-data route', async () => {
    const { fixture, router, http, preload } = await setup();
    await router.navigateByUrl('/home');
    await flush(fixture);

    preload.startPreload('/nope/123');
    await flush(fixture);

    http.expectNone('/api/users/123');
    http.expectNone(() => true); // no requests at all
  });

  it('two-phase for lazy routes: warms data only after the chunk is loaded', async () => {
    const { fixture, router, http, preload } = await setup();
    await router.navigateByUrl('/home');
    await flush(fixture);

    // phase 1 — chunk not loaded yet, the route's data factory isn't discoverable
    preload.startPreload('/lazy/item/5');
    await flush(fixture);
    http.expectNone('/api/items/5');

    // load the lazy chunk by navigating into it (its own data fires)
    await router.navigateByUrl('/lazy/item/9');
    await flush(fixture);
    http.expectOne('/api/items/9').flush('Nine');
    await flush(fixture);

    // phase 2 — the factory is now discoverable, a hover warms the data
    preload.startPreload('/lazy/item/5');
    await flush(fixture);
    http.expectOne('/api/items/5').flush('Five');
    await flush(fixture);
  });
});
