/* eslint-disable @angular-eslint/component-selector */
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { createTitle } from '../title/title-store';
import { TransitionRouterOutlet } from './../transition-router-outlet';
import { provideRouteA11y, type RouteA11yOptions } from './route-a11y';

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
  { path: 'a', component: PageA, resolve: { title: createTitle('Page A') } },
  { path: 'b', component: PageB, resolve: { title: createTitle('Page B') } },
  {
    path: 'one',
    component: PagePlain,
    resolve: { title: createTitle('Page One') },
  },
];

@Component({
  selector: 'a11y-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class A11yHost {}

async function setup(options?: RouteA11yOptions) {
  const rendered = await render(A11yHost, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouteA11y(options),
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

const liveRegion = () =>
  document.querySelector('[aria-live="polite"]') as HTMLElement | null;

describe('provideRouteA11y', () => {
  afterEach(() => {
    liveRegion()?.remove();
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true });
  });

  it('announces the committed title and focuses the view that swapped in', async () => {
    const { fixture, container, router } = await setup();

    await router.navigateByUrl('/one');
    await flush(fixture);

    const view = container.querySelector('page-plain') as HTMLElement;
    expect(document.activeElement).toBe(view);
    expect(view.getAttribute('tabindex')).toBe('-1');
    expect(liveRegion()?.textContent).toBe('Page One');
  });

  it('the transient tabindex goes away when focus leaves', async () => {
    const { fixture, container, router } = await setup();

    await router.navigateByUrl('/one');
    await flush(fixture);
    const view = container.querySelector('page-plain') as HTMLElement;
    expect(view.getAttribute('tabindex')).toBe('-1');

    view.blur();
    expect(view.hasAttribute('tabindex')).toBe(false);
  });

  it('waits for the swap: nothing is announced while the old view is still on screen', async () => {
    const { fixture, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    expect(liveRegion()?.textContent).toBe('Page A');

    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(liveRegion()?.textContent).toBe('Page A'); // router is done, screen is not

    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(liveRegion()?.textContent).toBe('Page B');
  });

  it('says nothing for a navigation superseded before it reached the screen', async () => {
    const { fixture, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');
    expect(liveRegion()?.textContent).toBe('Page A');

    await router.navigateByUrl('/one');
    await flush(fixture);

    // 'Page B' was never said: it went straight from A to One.
    expect(liveRegion()?.textContent).toBe('Page One');
  });

  it('honours `announce: false`', async () => {
    const { fixture, container, router } = await setup({ announce: false });

    await router.navigateByUrl('/one');
    await flush(fixture);

    expect(liveRegion()).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('page-plain') as HTMLElement,
    );
  });

  it('honours `focus: false`', async () => {
    const { fixture, container, router } = await setup({ focus: false });

    await router.navigateByUrl('/one');
    await flush(fixture);

    expect(liveRegion()?.textContent).toBe('Page One');
    expect(document.activeElement).not.toBe(
      container.querySelector('page-plain') as HTMLElement,
    );
  });
});
