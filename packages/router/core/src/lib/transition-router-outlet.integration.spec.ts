/* eslint-disable @angular-eslint/component-selector */
/**
 * Integration for the transition outlet itself, with real `httpResource` + `HttpTestingController`
 * — components create their own resource and register it via `registerResource` (no route-data),
 * exercising the outlet's hold/swap, per-view isolation, immediate opt-out, and nesting against
 * genuine async request timing. (Fine-grained edge timing is covered deterministically in the
 * unit spec; this proves it end-to-end with the real HTTP pipeline.)
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
import { TransitionRouterOutlet } from './transition-router-outlet';

let lastAData: ReturnType<typeof httpResource<string>> | undefined;

@Component({ selector: 'page-a', template: `A:{{ data.value() ?? '...' }}` })
class PageA {
  readonly data = httpResource<string>(() => '/api/a');
  constructor() {
    lastAData = this.data;
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

@Component({ selector: 'page-c', template: `C:{{ data.value() ?? '...' }}` })
class PageC {
  readonly data = httpResource<string>(() => '/api/c');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({ selector: 'plain-x', template: `X` })
class PlainX {}

@Component({
  selector: 'child-deep',
  template: `deep:{{ data.value() ?? '...' }}`,
})
class ChildDeep {
  readonly data = httpResource<string>(() => '/api/deep');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({
  selector: 'parent-layout',
  imports: [TransitionRouterOutlet],
  template: `parent|<mm-transition-outlet />`,
})
class ParentLayout {}

@Component({
  selector: 'outlet-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class OutletHost {}

function routes() {
  return [
    { path: 'a', component: PageA },
    { path: 'b', component: PageB },
    { path: 'c', component: PageC },
    { path: 'x', component: PlainX },
    { path: 'imm', component: PageB, data: { immediateTransition: true } },
    {
      path: 'p',
      component: ParentLayout,
      children: [
        { path: 'shallow', component: PlainX },
        { path: 'deep', component: ChildDeep },
      ],
    },
  ];
}

async function setup() {
  const rendered = await render(OutletHost, {
    providers: [
      provideRouter(routes()),
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

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('transition outlet integration (real httpResource)', () => {
  // destroyed components cancel their in-flight requests — expected here
  afterEach(() => TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }));

  it('holds the current view until the incoming request settles, then swaps', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    expect(container.textContent).toContain('A:AA');

    await router.navigateByUrl('/b');
    await flush(fixture);
    const bReq = http.expectOne('/api/b');
    expect(container.querySelector('page-a')).not.toBeNull(); // held while B loads
    expect(
      (container.querySelector('page-b') as HTMLElement | null)?.style.display,
    ).toBe('none');

    bReq.flush('BB');
    await flush(fixture);
    expect(container.querySelector('page-a')).toBeNull();
    expect(container.textContent).toContain('B:BB');
  });

  it('per-view isolation: an in-flight reload on the held view does not block the swap', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    // A reloads → its request goes in flight again while it's the outgoing view
    lastAData?.reload();
    await flush(fixture);
    const reloadReq = http.expectOne('/api/a');

    await router.navigateByUrl('/b');
    await flush(fixture);
    const bReq = http.expectOne('/api/b');
    expect(container.querySelector('page-a')).not.toBeNull(); // A held, still reloading

    bReq.flush('BB');
    await flush(fixture);

    // swapped even though A's reload never settled — the swap watches the incoming view only
    expect(container.querySelector('page-a')).toBeNull();
    expect(container.textContent).toContain('B:BB');
    expect(reloadReq.cancelled).toBe(true); // A's reload was cancelled when A was destroyed
  });

  it('an interrupting navigation mid-hold re-targets the hold', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    await router.navigateByUrl('/b'); // B loading → A held, B hidden
    await flush(fixture);
    const bReq = http.expectOne('/api/b');
    expect(container.querySelector('page-a')).not.toBeNull();

    await router.navigateByUrl('/c'); // interrupt before B settles
    await flush(fixture);
    expect(bReq.cancelled).toBe(true); // half-loaded B destroyed
    const cReq = http.expectOne('/api/c');
    expect(container.querySelector('page-a')).not.toBeNull(); // stable A still visible
    expect(container.querySelector('page-b')).toBeNull();

    cReq.flush('CC');
    await flush(fixture);
    expect(container.querySelector('page-a')).toBeNull();
    expect(container.textContent).toContain('C:CC');
  });

  it('data: { immediateTransition: true } swaps in immediately, even while loading', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    await router.navigateByUrl('/imm'); // opted out of the hold
    await flush(fixture);

    expect(container.querySelector('page-a')).toBeNull(); // previous dropped immediately
    expect(container.textContent).toContain('B:...'); // shown despite still loading
    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(container.textContent).toContain('B:BB');
  });

  it('nested outlet holds at its own level while the parent stays put', async () => {
    const { fixture, container, router, http } = await setup();

    await router.navigateByUrl('/p/shallow');
    await flush(fixture);
    expect(container.textContent).toContain('parent|');
    expect(container.textContent).toContain('X');

    await router.navigateByUrl('/p/deep'); // child loads data → nested outlet holds shallow
    await flush(fixture);
    const deepReq = http.expectOne('/api/deep');
    expect(container.textContent).toContain('parent|'); // parent untouched
    expect(container.querySelector('plain-x')).not.toBeNull(); // shallow held

    deepReq.flush('DD');
    await flush(fixture);
    expect(container.querySelector('plain-x')).toBeNull();
    expect(container.textContent).toContain('deep:DD');
    expect(container.textContent).toContain('parent|'); // still there
  });
});
