/* eslint-disable @angular-eslint/component-selector */
/**
 * End-to-end integration for the route-level data features, wired the way an app would:
 * lazy `loadComponent` routes, real `httpResource` (Angular-native — no @mmstack/resource
 * dependency; queryResource sits on the same primitive, so what holds here holds there),
 * `HttpTestingController` for real request timing, the `TransitionRouterOutlet`,
 * `provideRouteData`/`createRouteData`/`injectRouteData`, and `withRouteData()` prefetch
 * driven by the same `PreloadRequester` signal `mmLink` emits.
 */
import { provideLocationMocks } from '@angular/common/testing';
import {
  httpResource,
  type HttpResourceRef,
  provideHttpClient,
} from '@angular/common/http';
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

type User = { name: string };
const USER = routeDataKey<HttpResourceRef<User | undefined>>('user');

@Component({ selector: 'route-home', template: `home` })
class HomeCmp {}

@Component({ selector: 'route-user', template: `user:{{ data.value()?.name }}` })
class UserCmp {
  readonly data = injectRouteData(USER);
}

@Component({
  selector: 'int-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

function userRoutes() {
  return [
    { path: 'home', component: HomeCmp },
    {
      path: 'users/:id',
      // lazy, like a real code-split route
      loadComponent: () => Promise.resolve(UserCmp),
      providers: [provideRouteData(USER)],
      resolve: {
        user: createRouteData(USER, (ctx) => {
          const res = httpResource<User>(
            () => `/api/users/${ctx.params()['id']}`,
          );
          registerResource(res, { suspends: true });
          return res;
        }),
      },
    },
  ];
}

async function setup() {
  const rendered = await render(Host, {
    providers: [
      provideRouter(userRoutes()),
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
  };
}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('route-data integration (lazy routes + httpResource + transition outlet)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('fires the lazy route data at match, holds the previous view, swaps when the request settles', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(container.textContent).toContain('home');

    await router.navigateByUrl('/users/1');
    await flush(fixture);

    // the route-data request is in flight → the outlet still shows home
    const req = http.expectOne('/api/users/1');
    expect(container.querySelector('route-home')).not.toBeNull();

    req.flush({ name: 'Alice' });
    await flush(fixture);

    // settled → swapped to the lazy user view showing the resolved data
    expect(container.querySelector('route-home')).toBeNull();
    expect(container.textContent).toContain('user:Alice');
  });

  it('re-fires with live params on a param-only navigation', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/users/1');
    await flush(fixture);
    http.expectOne('/api/users/1').flush({ name: 'Alice' });
    await flush(fixture);
    expect(container.textContent).toContain('user:Alice');

    await router.navigateByUrl('/users/2');
    await flush(fixture);
    http.expectOne('/api/users/2').flush({ name: 'Bob' });
    await flush(fixture);

    expect(container.textContent).toContain('user:Bob');
  });

  it('prefetches route data on the mmLink preload signal (request fires before navigation)', async () => {
    const { fixture, router, http } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);

    // simulate mmLink hover/visible intent for /users/9
    TestBed.inject(PreloadRequester).startPreload('/users/9');
    await flush(fixture);

    // the data request was issued by the prefetch path, before any navigation
    const req = http.expectOne('/api/users/9');
    req.flush({ name: 'Nine' });
    await flush(fixture);
  });
});

// ——— nested resolvers: a parent layout route + child routes, each with its own data ———

type Org = { name: string };
type Settings = { theme: string };
const ORG = routeDataKey<HttpResourceRef<Org | undefined>>('org');
const SETTINGS = routeDataKey<HttpResourceRef<Settings | undefined>>('settings');

@Component({
  selector: 'org-layout',
  imports: [TransitionRouterOutlet],
  template: `org:{{ org.value()?.name }}|<mm-transition-outlet />`,
})
class OrgLayout {
  readonly org = injectRouteData(ORG);
}

@Component({ selector: 'route-settings', template: `settings:{{ data.value()?.theme }}` })
class SettingsCmp {
  readonly data = injectRouteData(SETTINGS);
}

function nestedRoutes() {
  return [
    { path: 'home', component: HomeCmp },
    {
      path: 'org/:orgId',
      loadComponent: () => Promise.resolve(OrgLayout),
      providers: [provideRouteData(ORG)],
      resolve: {
        org: createRouteData(ORG, (ctx) => {
          const res = httpResource<Org>(() => `/api/orgs/${ctx.params()['orgId']}`);
          registerResource(res, { suspends: true });
          return res;
        }),
      },
      children: [
        {
          path: 'users/:id',
          loadComponent: () => Promise.resolve(UserCmp),
          providers: [provideRouteData(USER)],
          resolve: {
            user: createRouteData(USER, (ctx) => {
              const res = httpResource<User>(() => `/api/users/${ctx.params()['id']}`);
              registerResource(res, { suspends: true });
              return res;
            }),
          },
        },
        {
          path: 'settings',
          loadComponent: () => Promise.resolve(SettingsCmp),
          providers: [provideRouteData(SETTINGS)],
          resolve: {
            settings: createRouteData(SETTINGS, () => {
              const res = httpResource<Settings>(() => `/api/settings`);
              registerResource(res, { suspends: true });
              return res;
            }),
          },
        },
      ],
    },
  ];
}

async function nestedSetup() {
  const rendered = await render(Host, {
    providers: [
      provideRouter(nestedRoutes()),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    ...rendered,
    router: TestBed.inject(Router),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('route-data integration — nested resolvers', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('fires the parent and child loaders in parallel, holding the previous view until they settle', async () => {
    const { fixture, container, router, http } = await nestedSetup();

    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(container.textContent).toContain('home');

    await router.navigateByUrl('/org/7/users/3');
    await flush(fixture);

    // BOTH loaders fired at match — the two requests are in flight at the same time,
    // before either has resolved (proves parallel, match-time firing across the chain)
    const orgReq = http.expectOne('/api/orgs/7');
    const userReq = http.expectOne('/api/users/3');
    expect(container.querySelector('route-home')).not.toBeNull(); // top outlet still holding

    orgReq.flush({ name: 'Acme' });
    await flush(fixture);
    expect(container.textContent).toContain('org:Acme'); // parent settled → top swapped in

    userReq.flush({ name: 'Cara' });
    await flush(fixture);
    expect(container.textContent).toContain('user:Cara');
    expect(container.querySelector('route-home')).toBeNull();
  });

  it('retains the parent loader across sibling navigation; the child outlet holds the swap', async () => {
    const { fixture, container, router, http } = await nestedSetup();

    await router.navigateByUrl('/org/7/users/3');
    await flush(fixture);
    http.expectOne('/api/orgs/7').flush({ name: 'Acme' });
    http.expectOne('/api/users/3').flush({ name: 'Cara' });
    await flush(fixture);
    expect(container.textContent).toContain('org:Acme');
    expect(container.textContent).toContain('user:Cara');

    // navigate to a SIBLING child — parent route is retained
    await router.navigateByUrl('/org/7/settings');
    await flush(fixture);

    http.expectNone('/api/orgs/7'); // parent loader did NOT re-fire (memoized, same orgId)
    const settingsReq = http.expectOne('/api/settings');
    expect(container.textContent).toContain('user:Cara'); // child outlet holds the old child

    settingsReq.flush({ theme: 'dark' });
    await flush(fixture);

    expect(container.textContent).toContain('settings:dark');
    expect(container.textContent).not.toContain('user:Cara'); // child swapped
    expect(container.textContent).toContain('org:Acme'); // parent untouched, still shown
  });
});
