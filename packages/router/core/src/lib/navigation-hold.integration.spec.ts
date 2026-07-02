/* eslint-disable @angular-eslint/component-selector */
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
import { holdThroughNavigation, type HeldResource } from './navigation-hold';
import {
  createRouteData,
  injectRouteData,
  provideRouteData,
  routeDataKey,
} from './route-data/route-data';
import { TransitionRouterOutlet } from './transition-router-outlet';

type User = { name: string };
const USER = routeDataKey<HeldResource<User | undefined>>('user');

@Component({
  selector: 'held-user',
  template: `user:{{ data.value()?.name ?? 'BLANK' }}|loading:{{ data.isLoading() }}`,
})
class UserCmp {
  readonly data = injectRouteData(USER);
}

@Component({
  selector: 'hold-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('holdThroughNavigation integration — reused route-data resource (the README combo)', () => {
  it('does not flash to loading on a param-only navigation', async () => {
    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'users/:id',
            component: UserCmp,
            providers: [provideRouteData(USER)],
            resolve: {
              user: createRouteData(USER, (ctx) => {
                const res = httpResource<User>(
                  () => `/api/users/${ctx.params()['id']}`,
                );
                registerResource(res, { suspends: true });
                return holdThroughNavigation(res);
              }),
            },
          },
        ]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const router = TestBed.inject(Router);
    const http = TestBed.inject(HttpTestingController);

    await router.navigateByUrl('/users/1');
    await flush(fixture);
    http.expectOne('/api/users/1').flush({ name: 'Alice' });
    await flush(fixture);
    expect(container.textContent).toContain('user:Alice');

    // param-only navigation — same route reused, refetch starts around NavigationEnd
    await router.navigateByUrl('/users/2');
    await flush(fixture);

    // the new request is in flight — the held view must still show Alice, not a blank/loading flash
    const req = http.expectOne('/api/users/2'); // request went out
    expect(container.textContent).toContain('user:Alice');
    expect(container.textContent).toContain('loading:false');

    req.flush({ name: 'Bob' });
    await flush(fixture);
    expect(container.textContent).toContain('user:Bob');
  });
});
