/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './transition-router-outlet';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
};

function makeRef(status: ResourceStatus): FakeRef {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(undefined);
  return {
    status: status$,
    value: value$,
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => value$() !== undefined,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

const B_REF = new InjectionToken<FakeRef>('test-b-ref');

@Component({ selector: 'route-a', template: `route-A` })
class RouteA {}

// Reads a route param (proves super-delegation kept the route injector intact) and
// registers its loading resource into the outlet's transition scope.
@Component({ selector: 'route-b', template: `route-B id={{ id }}` })
class RouteB {
  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id');
  constructor() {
    registerResource(inject(B_REF), { suspends: false });
  }
}

@Component({
  selector: 'test-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

describe('TransitionRouterOutlet', () => {
  it('holds the current route until the incoming settles, swaps on ready, params resolve', async () => {
    const ref = makeRef('loading');
    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          { path: 'a', component: RouteA },
          { path: 'b/:id', component: RouteB },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    const router = TestBed.inject(Router);

    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();
    expect(container.querySelector('route-a')).not.toBeNull();
    expect(container.querySelector('route-b')).toBeNull();

    // navigate to B (still loading) — A must hold, B mounts hidden, param resolved
    await router.navigateByUrl('/b/42');
    await flush();

    const routeA = container.querySelector('route-a') as HTMLElement | null;
    const routeB = container.querySelector('route-b') as HTMLElement | null;
    expect(routeA).not.toBeNull(); // held — did NOT swap early
    expect(routeB).not.toBeNull(); // incoming mounted...
    expect(routeB?.style.display).toBe('none'); // ...but hidden
    expect(routeB?.textContent).toContain('id=42'); // ActivatedRoute param resolved via super

    // settle B → swap in one frame, drop A
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush();

    expect(container.querySelector('route-a')).toBeNull();
    const swapped = container.querySelector('route-b') as HTMLElement | null;
    expect(swapped).not.toBeNull();
    expect(swapped?.style.display).not.toBe('none');
    expect(swapped?.textContent).toContain('id=42');
  });

  it('swaps a no-async route immediately (no resource to wait on)', async () => {
    @Component({ selector: 'route-x', template: `route-X` })
    class RouteX {}
    @Component({ selector: 'route-y', template: `route-Y` })
    class RouteY {}

    @Component({
      selector: 'test-host2',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host2 {}

    const { fixture, container } = await render(Host2, {
      providers: [
        provideRouter([
          { path: 'x', component: RouteX },
          { path: 'y', component: RouteY },
        ]),
        provideLocationMocks(),
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/x');
    await flush();
    expect(container.textContent).toContain('route-X');

    await router.navigateByUrl('/y');
    await flush();
    // microtask fallback releases the swap — Y shown, X gone, no hidden host left behind
    expect(container.querySelector('route-x')).toBeNull();
    expect(container.textContent).toContain('route-Y');
  });

  it('a route with data.immediateTransition swaps immediately (no hold)', async () => {
    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B id={{ id }}` })
    class RB {
      protected readonly id =
        inject(ActivatedRoute).snapshot.paramMap.get('id');
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'imm-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class ImmHost {}

    const ref = makeRef('loading');
    const { fixture, container } = await render(ImmHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b/:id', component: RB, data: { immediateTransition: true } },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();
    expect(container.textContent).toContain('route-A');

    // navigate to the opt-out route while it's still loading — it swaps in NOW, no hold
    await router.navigateByUrl('/b/9');
    await flush();
    expect(container.querySelector('route-a')).toBeNull(); // previous dropped immediately
    expect(container.textContent).toContain('route-B id=9'); // shown despite loading
  });

  it('a denied canActivate guard leaves the current route in place (no held/incoming leak)', async () => {
    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {}
    @Component({
      selector: 'g-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class GHost {}

    const { fixture, container } = await render(GHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB, canActivate: [() => false] },
        ]),
        provideLocationMocks(),
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();
    expect(container.textContent).toContain('route-A');

    const ok = await router.navigateByUrl('/b'); // guard denies
    await flush();
    expect(ok).toBe(false);
    expect(container.textContent).toContain('route-A'); // stayed put
    expect(container.querySelector('route-b')).toBeNull(); // never mounted/held
  });

  it('swaps even when the incoming route errors (does not hang the hold)', async () => {
    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'e-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class EHost {}

    const ref = makeRef('loading');
    const { fixture, container } = await render(EHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();
    await router.navigateByUrl('/b');
    await flush();
    expect(container.textContent).toContain('route-A'); // held while loading

    ref.status.set('error'); // request fails → settles (not loading/reloading)
    await flush();
    expect(container.querySelector('route-a')).toBeNull(); // swapped, didn't hang
    expect(container.textContent).toContain('route-B'); // shows the (errored) route
  });

  it('composes with a route resolver: holds through the resolver, then through the load', async () => {
    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'r-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class RHost {}

    let resolveResolver!: (v: unknown) => void;
    const resolverPromise = new Promise((r) => (resolveResolver = r));
    const ref = makeRef('loading');

    const { fixture, container } = await render(RHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB, resolve: { x: () => resolverPromise } },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/a');
    await flush();

    // navigate to B — its resolver is pending, so B isn't activated yet; A stays (router-level hold)
    void router.navigateByUrl('/b');
    await flush();
    expect(container.textContent).toContain('route-A');
    expect(container.querySelector('route-b')).toBeNull();

    // resolver completes → B activates, but its resource is still loading → outlet holds A
    resolveResolver(42);
    await flush();
    expect(container.textContent).toContain('route-A'); // still held (now by the outlet)

    // resource settles → swap
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush();
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });

  it('works when NESTED: a child outlet inside a parent route still holds-and-swaps', async () => {
    @Component({ selector: 'child-one', template: `child-1` })
    class ChildOne {}
    // The deeper child loads data into the (nested) outlet's scope.
    @Component({ selector: 'child-two', template: `child-2` })
    class ChildTwo {
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'parent-cmp',
      imports: [TransitionRouterOutlet],
      template: `parent:<mm-transition-outlet />`,
    })
    class ParentCmp {}
    @Component({
      selector: 'nest-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class NestHost {}

    const ref = makeRef('loading');
    const { fixture, container } = await render(NestHost, {
      providers: [
        provideRouter([
          {
            path: 'p',
            component: ParentCmp,
            children: [
              { path: 'c1', component: ChildOne },
              { path: 'c2', component: ChildTwo },
            ],
          },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    const router = TestBed.inject(Router);
    const flush = async () => {
      for (let i = 0; i < 6; i++) {
        fixture.detectChanges();
        await Promise.resolve();
      }
      fixture.detectChanges();
    };

    await router.navigateByUrl('/p/c1');
    await flush();
    expect(container.textContent).toContain('parent:');
    expect(container.textContent).toContain('child-1');

    // navigate within the parent to c2 (loading) — the NESTED outlet holds c1
    await router.navigateByUrl('/p/c2');
    await flush();
    expect(container.textContent).toContain('parent:'); // parent route unchanged, stays
    expect(container.querySelector('child-one')).not.toBeNull(); // held
    expect(container.querySelector('child-two')).not.toBeNull(); // incoming mounted (hidden)

    // c2 settles → nested swap
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush();
    expect(container.querySelector('child-one')).toBeNull();
    expect(container.textContent).toContain('child-2');
    expect(container.textContent).toContain('parent:'); // parent still there
  });
});
