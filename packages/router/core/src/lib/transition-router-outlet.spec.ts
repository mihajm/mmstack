/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  inject,
  InjectionToken,
  input,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  type DetachedRouteHandle,
  provideRouter,
  Router,
  RouteReuseStrategy,
  withComponentInputBinding,
  withViewTransitions,
} from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './transition-router-outlet';
import {
  mmRouterViewTransitions,
  RouterViewTransitions,
} from './view-transition';

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

  // ——— RouterOutlet-contract regressions: the bugs below all passed the old suite ———

  it('CanDeactivate guards receive the REAL component instance (outlet stays activated)', async () => {
    // the old implementation detached the live activation, so the router saw
    // `!outlet.isActivated` during preactivation and ran CanDeactivate(null, ...)
    let captured: unknown = 'never-called';

    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {}
    @Component({
      selector: 'cd-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class CdHost {}

    const { fixture, container } = await render(CdHost, {
      providers: [
        provideRouter([
          {
            path: 'a',
            component: RA,
            canDeactivate: [
              (component: RA) => {
                captured = component;
                return true;
              },
            ],
          },
          { path: 'b', component: RB },
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
    await router.navigateByUrl('/b');
    await flush();

    expect(captured).toBeInstanceOf(RA);
    expect(container.textContent).toContain('route-B');
  });

  it('withComponentInputBinding keeps re-binding on same-component param changes', async () => {
    // the old implementation made the router unsubscribe its input-binding stream
    // after the first emission (`!outlet.isActivated`) — inputs froze on /i/1
    @Component({ selector: 'route-i', template: `id={{ id() }}` })
    class RI {
      readonly id = input<string>();
    }
    @Component({
      selector: 'ib-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class IbHost {}

    const { fixture, container } = await render(IbHost, {
      providers: [
        provideRouter(
          [{ path: 'i/:id', component: RI }],
          withComponentInputBinding(),
        ),
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

    await router.navigateByUrl('/i/1');
    await flush();
    expect(container.textContent).toContain('id=1');

    // same component instance, new param — no deactivation happens, only re-binding
    await router.navigateByUrl('/i/2');
    await flush();
    expect(container.textContent).toContain('id=2');
  });

  it('composes with a custom RouteReuseStrategy (detach stores, attach restores, no 4012)', async () => {
    let constructions = 0;

    @Component({ selector: 'route-a', template: `route-A` })
    class RA {
      constructor() {
        constructions++;
      }
    }
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {}
    @Component({
      selector: 'rr-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class RrHost {}

    class StoreA implements RouteReuseStrategy {
      private stored: DetachedRouteHandle | null = null;
      shouldDetach(route: ActivatedRouteSnapshot): boolean {
        return route.routeConfig?.path === 'a';
      }
      store(
        route: ActivatedRouteSnapshot,
        handle: DetachedRouteHandle | null,
      ): void {
        this.stored = handle;
      }
      shouldAttach(route: ActivatedRouteSnapshot): boolean {
        return route.routeConfig?.path === 'a' && this.stored !== null;
      }
      retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
        return route.routeConfig?.path === 'a' ? this.stored : null;
      }
      shouldReuseRoute(
        future: ActivatedRouteSnapshot,
        curr: ActivatedRouteSnapshot,
      ): boolean {
        return future.routeConfig === curr.routeConfig;
      }
    }

    const { fixture, container } = await render(RrHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB },
        ]),
        provideLocationMocks(),
        { provide: RouteReuseStrategy, useValue: new StoreA() },
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
    expect(constructions).toBe(1);

    // a → b: the router calls outlet.detach() to store A — the old implementation
    // had already zeroed `activated`, so this threw RuntimeError 4012
    await router.navigateByUrl('/b');
    await flush();
    expect(container.textContent).toContain('route-B');

    // b → a: the stored handle re-attaches; A must NOT be constructed again
    await router.navigateByUrl('/a');
    await flush();
    expect(container.textContent).toContain('route-A');
    expect(container.querySelector('route-b')).toBeNull();
    expect(constructions).toBe(1);
  });

  it('child → parent navigation unmounts the child (deactivate with no follow-up activation)', async () => {
    @Component({ selector: 'child-one', template: `child-1` })
    class ChildOne {}
    @Component({
      selector: 'parent-cmp',
      imports: [TransitionRouterOutlet],
      template: `parent:<mm-transition-outlet />`,
    })
    class ParentCmp {}
    @Component({
      selector: 'up-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class UpHost {}

    const { fixture, container } = await render(UpHost, {
      providers: [
        provideRouter([
          {
            path: 'p',
            component: ParentCmp,
            children: [{ path: 'c', component: ChildOne }],
          },
        ]),
        provideLocationMocks(),
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

    await router.navigateByUrl('/p/c');
    await flush();
    expect(container.querySelector('child-one')).not.toBeNull();

    // the nested outlet deactivates with NOTHING following — the old implementation's
    // deactivate-suppression left the child view mounted forever
    await router.navigateByUrl('/p');
    await flush();
    expect(container.querySelector('child-one')).toBeNull();
    expect(container.textContent).toContain('parent:');
  });

  it('an interrupting navigation mid-hold re-targets the hold (stable view stays visible)', async () => {
    const C_REF = new InjectionToken<FakeRef>('test-c-ref');

    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({ selector: 'route-c', template: `route-C` })
    class RC {
      constructor() {
        registerResource(inject(C_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'mh-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class MhHost {}

    const refB = makeRef('loading');
    const refC = makeRef('loading');
    const { fixture, container } = await render(MhHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB },
          { path: 'c', component: RC },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: refB },
        { provide: C_REF, useValue: refC },
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

    await router.navigateByUrl('/a');
    await flush();
    await router.navigateByUrl('/b'); // B loading → A held, B hidden
    await flush();
    expect(container.querySelector('route-a')).not.toBeNull();

    // interrupt the hold BEFORE B settles: the half-loaded hidden B is destroyed
    // outright (capturing it would both blank the screen AND keep its resource
    // registered, deadlocking the scope); A keeps holding for C instead.
    await router.navigateByUrl('/c');
    await flush();

    const heldA = container.querySelector('route-a') as HTMLElement | null;
    expect(heldA).not.toBeNull(); // stable view STILL visible
    expect(heldA?.style.display).not.toBe('none');
    expect(container.querySelector('route-b')).toBeNull(); // half-loaded view gone
    const hiddenC = container.querySelector('route-c') as HTMLElement | null;
    expect(hiddenC).not.toBeNull(); // new incoming mounted...
    expect(hiddenC?.style.display).toBe('none'); // ...hidden while it loads

    // C settles → the re-targeted hold swaps A → C
    refC.value.set({ ok: true });
    refC.status.set('resolved');
    await flush();

    expect(container.querySelector('route-a')).toBeNull();
    const routeC = container.querySelector('route-c') as HTMLElement | null;
    expect(routeC).not.toBeNull();
    expect(routeC?.style.display).not.toBe('none');
  });

  it('wraps the swap in document.startViewTransition when viewTransition is set', async () => {
    @Component({ selector: 'route-a', template: `route-A` })
    class RA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RB {
      constructor() {
        registerResource(inject(B_REF), { suspends: false });
      }
    }
    @Component({
      selector: 'vt-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet viewTransition />`,
    })
    class VtHost {}

    // jsdom has no View Transitions API — install a synchronous mock
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return {};
    });
    (document as any).startViewTransition = startViewTransition;

    try {
      const ref = makeRef('loading');
      const { fixture, container } = await render(VtHost, {
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
      expect(startViewTransition).not.toHaveBeenCalled(); // still holding

      ref.value.set({ ok: true });
      ref.status.set('resolved');
      await flush();

      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(container.querySelector('route-a')).toBeNull(); // swap ran inside the VT callback
      expect(container.textContent).toContain('route-B');
    } finally {
      delete (document as any).startViewTransition;
    }
  });
});

// A controllable fake of the DOM `ViewTransition`: `finished` only settles when WE say
// so (mirroring reality, where it resolves at animation end — long after activation).
function deferredTransition() {
  let resolveFinished!: () => void;
  let rejectFinished!: (e?: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  // swallow the rejection path so an unhandled rejection can't fail the run
  finished.catch(() => undefined);
  return {
    skipTransition: vi.fn(),
    finished,
    // Angular's createViewTransition attaches `.catch` to all three — provide them so
    // the real-wiring integration tests don't trip on missing members.
    ready: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    resolveFinished,
    rejectFinished,
  };
}

describe('TransitionRouterOutlet ↔ Angular view transitions (outlet side)', () => {
  @Component({ selector: 'route-vta', template: `route-A` })
  class RA {}
  @Component({ selector: 'route-vtb', template: `route-B` })
  class RB {
    constructor() {
      registerResource(inject(B_REF), { suspends: false });
    }
  }
  // an immediate (no-hold) route that still loads — Angular should animate it, the
  // outlet must NOT take over
  @Component({ selector: 'route-vti', template: `route-I` })
  class RI {
    constructor() {
      registerResource(inject(B_REF), { suspends: false });
    }
  }

  @Component({
    selector: 'vt-host-default',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet />`,
  })
  class DefaultHost {}
  @Component({
    selector: 'vt-host-on',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet viewTransition />`,
  })
  class OnHost {}
  @Component({
    selector: 'vt-host-off',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet [viewTransition]="false" />`,
  })
  class OffHost {}

  const flush = async (fixture: { detectChanges: () => void }) => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  async function setup(host: typeof DefaultHost) {
    const ref = makeRef('loading');
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return deferredTransition();
    });
    (document as any).startViewTransition = startViewTransition;

    const rendered = await render(host, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB },
          { path: 'i', component: RI, data: { immediateTransition: true } },
        ]),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    return {
      ...rendered,
      ref,
      startViewTransition,
      coordinator: TestBed.inject(RouterViewTransitions),
      router: TestBed.inject(Router),
    };
  }

  afterEach(() => delete (document as any).startViewTransition);

  it('auto-animates the swap when router view transitions are enabled (no attribute)', async () => {
    const { fixture, ref, startViewTransition, coordinator, router } =
      await setup(DefaultHost);

    await router.navigateByUrl('/a');
    await flush(fixture);

    coordinator.enabled = true; // as mmRouterViewTransitions would set on first transition

    await router.navigateByUrl('/b'); // held (loading)
    await flush(fixture);
    expect(startViewTransition).not.toHaveBeenCalled(); // still holding

    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(startViewTransition).toHaveBeenCalledTimes(1); // swap animated, no attribute
  });

  it('does NOT animate when router view transitions are not enabled and no attribute is set', async () => {
    const { fixture, ref, startViewTransition, router } =
      await setup(DefaultHost);

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(startViewTransition).not.toHaveBeenCalled(); // instant swap
  });

  it('[viewTransition] (true) animates even when router view transitions are NOT enabled', async () => {
    const { fixture, ref, startViewTransition, coordinator, router } =
      await setup(OnHost);
    expect(coordinator.enabled).toBe(false);

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(startViewTransition).toHaveBeenCalledTimes(1); // explicit opt-in wins
  });

  it('[viewTransition]="false" forces the swap instant even when enabled app-wide', async () => {
    const { fixture, ref, startViewTransition, coordinator, router } =
      await setup(OffHost);

    await router.navigateByUrl('/a');
    await flush(fixture);
    coordinator.enabled = true;

    await router.navigateByUrl('/b');
    await flush(fixture);
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(startViewTransition).not.toHaveBeenCalled(); // forced off
  });

  it("skips Angular's inert activation-time transition while holding", async () => {
    const { fixture, coordinator, router } = await setup(DefaultHost);

    await router.navigateByUrl('/a');
    await flush(fixture);

    const t = deferredTransition();
    coordinator.enabled = true;
    coordinator.active = t;

    await router.navigateByUrl('/b'); // outlet holds → skips Angular's transition
    await flush(fixture);

    expect(t.skipTransition).toHaveBeenCalledTimes(1);
  });

  it('does NOT skip for an immediateTransition route (Angular animates it)', async () => {
    const { fixture, coordinator, router } = await setup(DefaultHost);

    await router.navigateByUrl('/a');
    await flush(fixture);

    const t = deferredTransition();
    coordinator.enabled = true;
    coordinator.active = t;

    await router.navigateByUrl('/i'); // immediate route — must let Angular transition it
    await flush(fixture);

    expect(t.skipTransition).not.toHaveBeenCalled();
  });

  it('does not throw when holding with no active router transition', async () => {
    const { fixture, ref, router, coordinator } = await setup(DefaultHost);
    coordinator.enabled = true;
    coordinator.active = null; // enabled but nothing in flight

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(fixture).toBeTruthy(); // reached here without throwing
  });

  it('skips each navigation’s own transition exactly once across successive holds', async () => {
    const { fixture, ref, router, coordinator } = await setup(DefaultHost);
    coordinator.enabled = true;

    await router.navigateByUrl('/a');
    await flush(fixture);

    // first held nav: its transition is active → skipped once
    const tB = deferredTransition();
    coordinator.active = tB;
    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(tB.skipTransition).toHaveBeenCalledTimes(1);

    // settle, then return to /a as housekeeping — clear `active` first so this
    // (itself a held nav) doesn't consume a skip on tB
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);
    coordinator.active = null;
    ref.status.set('loading');
    ref.value.set(undefined);
    await router.navigateByUrl('/a');
    await flush(fixture);

    // second held nav with its OWN active transition: the new one is skipped once,
    // the old one is never skipped again
    const tB2 = deferredTransition();
    coordinator.active = tB2;
    await router.navigateByUrl('/b');
    await flush(fixture);

    expect(tB.skipTransition).toHaveBeenCalledTimes(1);
    expect(tB2.skipTransition).toHaveBeenCalledTimes(1);
  });
});

describe('mmRouterViewTransitions (coordinator side)', () => {
  function makeInfo(transition: unknown) {
    return { transition, from: {}, to: {} } as never;
  }

  it('feeds the coordinator and chains the user callback', async () => {
    TestBed.configureTestingModule({});
    const coordinator = TestBed.inject(RouterViewTransitions);

    const userCb = vi.fn();
    const options = mmRouterViewTransitions({ onViewTransitionCreated: userCb });
    const t = deferredTransition();

    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(t)),
    );

    expect(coordinator.enabled).toBe(true);
    expect(coordinator.active).toBe(t);
    expect(userCb).toHaveBeenCalledTimes(1);

    t.resolveFinished();
    await t.finished;
    await Promise.resolve();
    expect(coordinator.active).toBeNull(); // cleared on finish
  });

  it('works without a user callback', () => {
    TestBed.configureTestingModule({});
    const coordinator = TestBed.inject(RouterViewTransitions);
    const options = mmRouterViewTransitions();
    const t = deferredTransition();

    expect(() =>
      TestBed.runInInjectionContext(() =>
        options.onViewTransitionCreated?.(makeInfo(t)),
      ),
    ).not.toThrow();
    expect(coordinator.active).toBe(t);
  });

  it('does NOT clear a newer active when an older transition finishes (stale-handle guard)', async () => {
    TestBed.configureTestingModule({});
    const coordinator = TestBed.inject(RouterViewTransitions);
    const options = mmRouterViewTransitions();

    const t1 = deferredTransition();
    const t2 = deferredTransition();

    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(t1)),
    );
    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(t2)),
    );
    expect(coordinator.active).toBe(t2);

    // t1 finishes LATE — it must NOT null out t2 (the in-flight one)
    t1.resolveFinished();
    await t1.finished;
    await Promise.resolve();
    expect(coordinator.active).toBe(t2);

    // t2 finishing clears it
    t2.resolveFinished();
    await t2.finished;
    await Promise.resolve();
    expect(coordinator.active).toBeNull();
  });

  it('clears active even when the transition is skipped/rejected', async () => {
    TestBed.configureTestingModule({});
    const coordinator = TestBed.inject(RouterViewTransitions);
    const options = mmRouterViewTransitions();
    const t = deferredTransition();

    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(t)),
    );
    expect(coordinator.active).toBe(t);

    t.rejectFinished(new Error('skipped'));
    await t.finished.catch(() => undefined);
    await Promise.resolve();
    expect(coordinator.active).toBeNull();
  });

  it('stays enabled across multiple transitions (idempotent)', () => {
    TestBed.configureTestingModule({});
    const coordinator = TestBed.inject(RouterViewTransitions);
    const options = mmRouterViewTransitions();

    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(deferredTransition())),
    );
    TestBed.runInInjectionContext(() =>
      options.onViewTransitionCreated?.(makeInfo(deferredTransition())),
    );
    expect(coordinator.enabled).toBe(true);
  });
});

// Real wiring: `withViewTransitions(mmRouterViewTransitions())` + the actual router
// navigation pipeline (guards, redirects, activation), with a stubbed
// `document.startViewTransition`. This proves the guard/redirect/timing guarantees
// (transitions are created post-guard, post-redirect, pre-activation, for the committed
// navigation only) rather than relying on hand-set coordinator state.
describe('view transitions — real router wiring (integration)', () => {
  @Component({ selector: 'route-ia', template: `route-A` })
  class IA {}
  @Component({ selector: 'route-ib', template: `route-B` })
  class IB {
    constructor() {
      registerResource(inject(B_REF), { suspends: false });
    }
  }
  @Component({ selector: 'route-id', template: `route-D` })
  class ID {}
  @Component({
    selector: 'int-host',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet />`,
  })
  class IntHost {}

  const flush = async (fixture: { detectChanges: () => void }) => {
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  async function setup() {
    const ref = makeRef('loading');
    const created: ReturnType<typeof deferredTransition>[] = [];
    (document as any).startViewTransition = vi.fn((cb: () => void) => {
      cb();
      const t = deferredTransition();
      created.push(t);
      return t;
    });

    const rendered = await render(IntHost, {
      providers: [
        provideRouter(
          [
            { path: 'a', component: IA },
            { path: 'b', component: IB },
            { path: 'denied', component: ID, canActivate: [() => false] },
            { path: 'redirect', redirectTo: 'a', pathMatch: 'full' },
          ],
          withViewTransitions(mmRouterViewTransitions()),
        ),
        provideLocationMocks(),
        { provide: B_REF, useValue: ref },
      ],
    });
    return {
      ...rendered,
      ref,
      created,
      coordinator: TestBed.inject(RouterViewTransitions),
      router: TestBed.inject(Router),
    };
  }

  afterEach(() => delete (document as any).startViewTransition);

  it('enables coordination through the real pipeline on first navigation', async () => {
    const { fixture, coordinator, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    // Angular actually invoked our onViewTransitionCreated
    expect(coordinator.enabled).toBe(true);
    expect(created.length).toBeGreaterThan(0);
  });

  it('on a held navigation, Angular creates the transition and the outlet skips it', async () => {
    const { fixture, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    const before = created.length;
    await router.navigateByUrl('/b'); // held (loading)
    await flush(fixture);

    // a transition was created for /b, and the outlet skipped Angular's inert one
    expect(created.length).toBe(before + 1);
    expect(created[created.length - 1].skipTransition).toHaveBeenCalledTimes(1);
  });

  it('a guard-denied navigation creates no transition (no stale active leaks)', async () => {
    const { fixture, coordinator, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    // resolve prior transitions so `active` returns to a clean null baseline
    created.forEach((t) => t.resolveFinished());
    await flush(fixture);
    expect(coordinator.active).toBeNull();

    const before = created.length;
    const ok = await router.navigateByUrl('/denied');
    await flush(fixture);

    expect(ok).toBe(false); // guard cancelled it upstream of the VT stage
    expect(created.length).toBe(before); // nothing created for the denied nav
    expect(coordinator.active).toBeNull(); // nothing leaked into the coordinator
  });

  it('a redirect produces a single committed transition and lands on the target', async () => {
    const { fixture, container, router, created } = await setup();
    await router.navigateByUrl('/b'); // settle onto /b first so /a is a real change
    await flush(fixture);

    const before = created.length;
    await router.navigateByUrl('/redirect'); // → /a
    await flush(fixture);

    expect(router.url).toBe('/a'); // committed to the redirect target
    // exactly one transition for the committed navigation (not one per hop)
    expect(created.length).toBe(before + 1);
  });
});
