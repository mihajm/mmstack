/* eslint-disable @angular-eslint/component-selector */
// What a staged (hidden, not-yet-committed) view is allowed to affect.
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import {
  provideRouter,
  type ResolveFn,
  Router,
  type Routes,
} from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { createTitle } from './title/title-store';
import { TransitionRouterOutlet } from './transition-router-outlet';
import { createStagedApply } from './util/staged-apply';

@Component({ selector: 'page-home', template: `home` })
class PageHome {}

@Component({ selector: 'page-x', template: `X:{{ data.value() ?? '...' }}` })
class PageX {
  readonly data = httpResource<string>(() => '/api/x');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({ selector: 'page-z', template: `Z` })
class PageZ {}

/** Set by the specs that watch a staged buffer directly; called from the probe resolvers. */
let probe: ((id: string) => void) | null = null;
const probeResolver =
  (id: string): ResolveFn<boolean> =>
  () => {
    probe?.(id);
    return true;
  };

const routes: Routes = [
  { path: 'r1', component: PageZ, resolve: { probe: probeResolver('r1') } },
  { path: 'r2', component: PageX, resolve: { probe: probeResolver('r2') } },
  {
    path: 'boom',
    component: PageZ,
    resolve: {
      probe: probeResolver('boom'),
      boom: () => {
        throw new Error('resolver exploded');
      },
    },
  },
  {
    path: 'home',
    component: PageHome,
    resolve: { title: createTitle('Home') },
  },
  {
    // Componentless parent: its title registration must outlive a sibling swap under it.
    path: 'p',
    resolve: { title: createTitle('Parent') },
    children: [
      { path: 'x', component: PageX, resolve: { title: createTitle('X') } },
      { path: 'z', component: PageZ },
    ],
  },
  { path: 'blocked', component: PageZ, canActivate: [() => false] },
];

@Component({
  selector: 'staging-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class StagingHost {}

async function setup() {
  const rendered = await render(StagingHost, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
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
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('staging hardening', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('the staged view is inert as well as display:none, and neither survives the swap', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);

    await router.navigateByUrl('/p/x');
    await flush(fixture);
    const staged = container.querySelector('page-x') as HTMLElement;
    expect(staged.style.display).toBe('none');
    expect(staged.hasAttribute('inert')).toBe(true);

    http.expectOne('/api/x').flush('XX');
    await flush(fixture);
    expect(staged.style.display).toBe('');
    expect(staged.hasAttribute('inert')).toBe(false);
  });

  it('the document title waits for the visual commit, not NavigationEnd', async () => {
    const { fixture, router, http, title } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(title.getTitle()).toBe('Home');

    const nav = router.navigateByUrl('/p/x');
    await nav;
    await flush(fixture);
    // Router is done, the old view is still the one on screen — so is its title.
    expect(title.getTitle()).toBe('Home');

    http.expectOne('/api/x').flush('XX');
    await flush(fixture);
    expect(title.getTitle()).toBe('X');
  });

  it('a buffer the visual commit never reached carries into the interrupting navigation', async () => {
    const { fixture, router, http, title } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);

    await router.navigateByUrl('/p/x');
    await flush(fixture);
    http.expectOne('/api/x');
    expect(title.getTitle()).toBe('Home');

    // Interrupts before /p/x was ever visible. `/p` is reused, so its resolver does not re-run:
    // its buffered title only survives if the buffer carried over.
    await router.navigateByUrl('/p/z');
    await flush(fixture);

    expect(title.getTitle()).toBe('Parent');
  });

  it('a cancelled navigation retitles nothing — until the swap it interrupted lands', async () => {
    const { fixture, router, http, title } = await setup();

    await router.navigateByUrl('/home');
    await flush(fixture);

    await router.navigateByUrl('/p/x');
    await flush(fixture);
    const held = http.expectOne('/api/x');
    expect(title.getTitle()).toBe('Home');

    expect(await router.navigateByUrl('/blocked')).toBe(false);
    await flush(fixture);
    expect(title.getTitle()).toBe('Home');

    // The cancelled navigation never reached the screen; the one it interrupted still does.
    held.flush('XX');
    await flush(fixture);
    expect(title.getTitle()).toBe('X');
  });
});

describe('staged buffer lifecycle', () => {
  afterEach(() => {
    probe = null;
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true });
  });

  const watch = () => {
    const applied: string[] = [];
    const stagedApply = TestBed.runInInjectionContext(() =>
      createStagedApply<string>((id) => applied.push(id), 'visual-commit'),
    );
    probe = (id) => stagedApply(id, id);
    return applied;
  };

  it('applies what a navigation buffered when it reaches the screen', async () => {
    const { fixture, router, http } = await setup();
    const applied = watch();

    await router.navigateByUrl('/r1');
    await flush(fixture);
    expect(applied).toEqual(['r1']);

    await router.navigateByUrl('/r2');
    await flush(fixture);
    expect(applied).toEqual(['r1']); // held: the router is done, the screen is not

    http.expectOne('/api/x').flush('XX');
    await flush(fixture);
    expect(applied).toEqual(['r1', 'r2']);
  });

  it('drops what a failed navigation buffered when nothing is outstanding', async () => {
    const { fixture, router, http } = await setup();
    const applied = watch();

    await router.navigateByUrl('/r1');
    await flush(fixture);
    expect(applied).toEqual(['r1']);

    await router.navigateByUrl('/boom').catch(() => undefined);
    await flush(fixture);
    expect(applied).toEqual(['r1']);

    // The next commit must not carry the dead navigation's registration with it.
    await router.navigateByUrl('/r2');
    await flush(fixture);
    http.expectOne('/api/x').flush('XX');
    await flush(fixture);
    expect(applied).toEqual(['r1', 'r2']);
  });

  it('keeps a buffer the outstanding swap still needs when a later navigation is cancelled', async () => {
    const { fixture, router, http } = await setup();
    const applied = watch();

    await router.navigateByUrl('/r1');
    await flush(fixture);

    await router.navigateByUrl('/r2');
    await flush(fixture);
    const held = http.expectOne('/api/x');
    expect(applied).toEqual(['r1']);

    expect(await router.navigateByUrl('/blocked')).toBe(false);
    await flush(fixture);
    expect(applied).toEqual(['r1']);

    held.flush('XX');
    await flush(fixture);
    expect(applied).toEqual(['r1', 'r2']);
  });
});
