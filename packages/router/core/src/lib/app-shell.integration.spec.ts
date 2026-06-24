/* eslint-disable @angular-eslint/component-selector */
/**
 * Cross-feature integration: title + breadcrumbs + nav + transition outlet + route-data +
 * mmLink prefetch, wired into one nested, lazily-loaded app shell and driven through real
 * navigation. Each feature is unit-tested in isolation elsewhere; this proves they
 * cooperate — one navigation updates the title, breadcrumb chain and nav-active state while
 * the outlet holds the previous view until the route's data settles, and an mmLink hover
 * warms the matched routes' data.
 */
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { createBreadcrumb } from './breadcrumb/breadcrumb-resolver';
import { injectBreadcrumbs } from './breadcrumb/breadcrumb-store';
import { Link } from './link';
import { createNavItems } from './nav/nav-resolver';
import { injectNavItems } from './nav/nav-store';
import {
  createRouteData,
  injectRouteData,
  provideRouteData,
  routeDataKey,
} from './route-data/route-data';
import { withRouteData } from './route-data/with-route-data';
import { createTitle } from './title/title-store';
import { TransitionRouterOutlet } from './transition-router-outlet';

type Org = { name: string };
type User = { name: string };
const ORG = routeDataKey<ReturnType<typeof httpResource<Org>>>('org');
const USER = routeDataKey<ReturnType<typeof httpResource<User>>>('user');

@Component({ selector: 'route-home', template: `home` })
class HomeCmp {}

@Component({
  selector: 'org-layout',
  imports: [TransitionRouterOutlet],
  template: `org:{{ org.value()?.name ?? '...' }}|<mm-transition-outlet />`,
})
class OrgLayout {
  readonly org = injectRouteData(ORG);
}

@Component({
  selector: 'user-page',
  template: `user:{{ user.value()?.name ?? '...' }}`,
})
class UserPage {
  readonly user = injectRouteData(USER);
}

@Component({ selector: 'settings-page', template: `settings` })
class SettingsPage {}

@Component({
  selector: 'app-shell',
  imports: [TransitionRouterOutlet, Link],
  template: `
    <div class="crumbs">
      @for (b of crumbs(); track b.link()) {
        <span class="crumb">{{ b.label() }}</span>
      }
    </div>
    <div class="nav">
      @for (n of navItems(); track n.id()) {
        <span class="nav-item" [attr.data-active]="n.active()">{{
          n.label()
        }}</span>
      }
    </div>
    <a [mmLink]="['/orgs/2/users/9']">prefetch-link</a>
    <mm-transition-outlet />
  `,
})
class AppShell {
  readonly crumbs = injectBreadcrumbs();
  readonly navItems = injectNavItems();
}

function routes() {
  return [
    { path: 'home', component: HomeCmp },
    {
      path: 'orgs/:orgId',
      loadComponent: () => Promise.resolve(OrgLayout),
      providers: [provideRouteData(ORG)],
      resolve: {
        org: createRouteData(ORG, (ctx) => {
          const res = httpResource<Org>(
            () => `/api/orgs/${ctx.params()['orgId']}`,
          );
          registerResource(res, { suspends: true });
          return res;
        }),
        title: createTitle((r) => `Org ${r.params['orgId']}`),
        crumb: createBreadcrumb((r) => `Org ${r.params['orgId']}`),
        nav: createNavItems([
          { label: 'Users', link: 'users' },
          { label: 'Settings', link: 'settings' },
        ]),
      },
      children: [
        {
          path: 'users/:id',
          loadComponent: () => Promise.resolve(UserPage),
          providers: [provideRouteData(USER)],
          resolve: {
            user: createRouteData(USER, (ctx) => {
              const res = httpResource<User>(
                () => `/api/users/${ctx.params()['id']}`,
              );
              registerResource(res, { suspends: true });
              return res;
            }),
            title: createTitle((r) => `User ${r.params['id']}`),
            crumb: createBreadcrumb((r) => `User ${r.params['id']}`),
          },
        },
        {
          path: 'settings',
          loadComponent: () => Promise.resolve(SettingsPage),
          resolve: {
            title: createTitle('Settings'),
            crumb: createBreadcrumb('Settings'),
          },
        },
      ],
    },
  ];
}

async function setup() {
  const rendered = await render(AppShell, {
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
    title: TestBed.inject(Title),
  };
}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 10; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

const crumbLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.crumb')).map((e) =>
    e.textContent?.trim(),
  );

const activeNav = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.nav-item'))
    .filter((e) => e.getAttribute('data-active') === 'true')
    .map((e) => e.textContent?.trim());

describe('app-shell cross-feature integration', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('one deep navigation updates title + breadcrumbs + nav while the outlet holds until data settles', async () => {
    const { fixture, container, router, http, title } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(container.textContent).toContain('home');

    await router.navigateByUrl('/orgs/1/users/5');
    await flush(fixture);

    // both route-data loaders fired; the top outlet holds /home until the parent settles
    const orgReq = http.expectOne('/api/orgs/1');
    const userReq = http.expectOne('/api/users/5');
    expect(container.querySelector('route-home')).not.toBeNull();

    orgReq.flush({ name: 'Acme' });
    userReq.flush({ name: 'Cara' });
    await flush(fixture);

    // everything cooperated off the one navigation
    expect(container.querySelector('route-home')).toBeNull();
    expect(container.textContent).toContain('org:Acme');
    expect(container.textContent).toContain('user:Cara');
    expect(title.getTitle()).toBe('User 5'); // deepest leaf's title
    expect(crumbLabels(container)).toEqual(['Org 1', 'User 5']);
    expect(activeNav(container)).toEqual(['Users']); // /orgs/1/users/5 → Users active
  });

  it('sibling navigation re-derives title/breadcrumbs/nav and retains the parent data', async () => {
    const { fixture, container, router, http, title } = await setup();

    await router.navigateByUrl('/orgs/1/users/5');
    await flush(fixture);
    http.expectOne('/api/orgs/1').flush({ name: 'Acme' });
    http.expectOne('/api/users/5').flush({ name: 'Cara' });
    await flush(fixture);
    expect(title.getTitle()).toBe('User 5');

    await router.navigateByUrl('/orgs/1/settings');
    await flush(fixture);

    http.expectNone('/api/orgs/1'); // parent org data retained (not refetched)
    expect(container.textContent).toContain('settings');
    expect(container.textContent).toContain('org:Acme'); // parent layout still shown
    expect(title.getTitle()).toBe('Settings');
    expect(crumbLabels(container)).toEqual(['Org 1', 'Settings']);
    expect(activeNav(container)).toEqual(['Settings']);
  });

  it('an mmLink hover warms the matched routes’ data across the chain', async () => {
    const { fixture, container, router, http } = await setup();
    await router.navigateByUrl('/home');
    await flush(fixture);

    const link = container.querySelector('a') as HTMLElement;
    link.dispatchEvent(new MouseEvent('mouseenter'));
    await flush(fixture);

    // hovering /orgs/2/users/9 warmed BOTH matched route-data loaders
    http.expectOne('/api/orgs/2').flush({ name: 'Beta' });
    http.expectOne('/api/users/9').flush({ name: 'Nine' });
    await flush(fixture);
  });
});
