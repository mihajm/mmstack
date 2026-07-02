/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
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

describe('holdThroughNavigation — eager settledness (unread consumers)', () => {
  // The settle machine is pull-based; these tests drive a navigation + refetch cycle
  // WITHOUT ever reading the held resource (the unmounted-consumer case), then check
  // whether a later manual reload's indicator passes through live.
  const snap = (status: string, value: unknown) =>
    ({ status, value, error: undefined }) as never;

  async function driveUnreadCycle(eager: boolean) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'a', children: [] }]),
        provideLocationMocks(),
      ],
    });
    const snapshot = signal(snap('resolved', { name: 'Alice' }));
    const fake = {
      snapshot,
      reload: () => true,
    } as unknown as Parameters<typeof holdThroughNavigation>[0];

    const held = TestBed.runInInjectionContext(() =>
      holdThroughNavigation<User | undefined>(
        fake as never,
        eager ? { eager: true } : undefined,
      ),
    );

    // navigation succeeds; the refetch runs just after NavigationEnd — all UNREAD
    await TestBed.inject(Router).navigateByUrl('/a');
    TestBed.tick();
    snapshot.set(snap('loading', undefined));
    TestBed.tick(); // eager watcher (when present) observes the in-flight frame
    snapshot.set(snap('resolved', { name: 'Bob' }));
    TestBed.tick();

    // ...now a manual reload, long after the navigation settled
    snapshot.set(snap('reloading', { name: 'Bob' }));
    TestBed.tick();
    return held;
  }

  it('without eager, an unread consumer misses the cycle and the reload is held (the caveat)', async () => {
    const held = await driveUnreadCycle(false);
    expect(held.isLoading()).toBe(false); // indicator wrongly hidden — documented caveat
  });

  it('eager: true keeps settledness tracked with zero readers — the reload passes live', async () => {
    const held = await driveUnreadCycle(true);
    expect(held.isLoading()).toBe(true); // cycle was observed → live pass-through
    expect(held.value()).toEqual({ name: 'Bob' });
  });
});
