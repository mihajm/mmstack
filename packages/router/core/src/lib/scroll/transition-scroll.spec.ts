/* eslint-disable @angular-eslint/component-selector */
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Location, ViewportScroller } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './../transition-router-outlet';
import { provideTransitionScrollRestoration } from './transition-scroll';

@Component({ selector: 'page-a', template: `A:{{ data.value() ?? '...' }}` })
class PageA {
  readonly data = httpResource<string>(() => '/api/a');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({ selector: 'page-b', template: `B:{{ data.value() ?? '...' }}` })
class PageB {
  readonly data = httpResource<string>(() => '/api/b');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({ selector: 'page-plain', template: `plain` })
class PagePlain {}

const routes: Routes = [
  { path: 'a', component: PageA },
  { path: 'b', component: PageB },
  { path: 'one', component: PagePlain },
  { path: 'two', component: PagePlain },
  { path: 'blocked', component: PagePlain, canActivate: [() => false] },
];

@Component({
  selector: 'scroll-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class ScrollHost {}

type ScrollCall =
  | { to: 'position'; value: [number, number] }
  | { to: 'anchor'; value: string };

function fakeScroller(calls: ScrollCall[], position: () => [number, number]) {
  return {
    getScrollPosition: () => position(),
    scrollToPosition: (value: [number, number]) =>
      calls.push({ to: 'position', value }),
    scrollToAnchor: (value: string) => calls.push({ to: 'anchor', value }),
    setHistoryScrollRestoration: () => undefined,
    scrollToElement: () => undefined,
    setOffset: () => undefined,
  } as unknown as ViewportScroller;
}

async function setup() {
  const calls: ScrollCall[] = [];
  let position: [number, number] = [0, 0];

  const rendered = await render(ScrollHost, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ViewportScroller,
        useValue: fakeScroller(calls, () => position),
      },
      provideTransitionScrollRestoration(),
    ],
  });

  // Normally wired by the bootstrap listener, which TestBed never fires.
  TestBed.inject(Router).setUpLocationChangeListener();

  return {
    ...rendered,
    calls,
    setPosition: (value: [number, number]) => (position = value),
    router: TestBed.inject(Router),
    location: TestBed.inject(Location),
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

describe('provideTransitionScrollRestoration', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('scrolls to the top of a forward navigation, once, at the visual commit', async () => {
    const { fixture, router, http, calls } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    calls.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(calls).toEqual([]); // NavigationEnd already happened; the old view is still visible

    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(calls).toEqual([{ to: 'position', value: [0, 0] }]);
  });

  it('scrolls to the URL fragment instead of the top when there is one', async () => {
    const { fixture, router, calls } = await setup();

    await router.navigateByUrl('/one#section');
    await flush(fixture);

    expect(calls).toEqual([{ to: 'anchor', value: 'section' }]);
  });

  it('never scrolls for a navigation that was superseded before it committed', async () => {
    const { fixture, router, http, calls } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    calls.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');

    await router.navigateByUrl('/one');
    await flush(fixture);
    expect(calls).toEqual([{ to: 'position', value: [0, 0] }]); // only the one that committed
  });

  it('still scrolls for a hold that lands after a later navigation was cancelled', async () => {
    const { fixture, router, http, calls } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    calls.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    const held = http.expectOne('/api/b');

    expect(await router.navigateByUrl('/blocked')).toBe(false);
    await flush(fixture);
    expect(calls).toEqual([]);

    // /b was never superseded, only interrupted — its swap is a real screen change.
    held.flush('BB');
    await flush(fixture);
    expect(calls).toEqual([{ to: 'position', value: [0, 0] }]);
  });

  it('restores the stored position when going back', async () => {
    const { fixture, router, location, calls, setPosition } = await setup();

    await router.navigateByUrl('/one');
    await flush(fixture);
    setPosition([0, 420]);

    await router.navigateByUrl('/two');
    await flush(fixture);
    calls.length = 0;

    location.back();
    // The router's popstate listener defers by a macrotask before it navigates.
    await new Promise((resolve) => setTimeout(resolve));
    await flush(fixture);

    expect(router.url).toBe('/one');
    expect(calls).toEqual([{ to: 'position', value: [0, 420] }]);
  });
});
