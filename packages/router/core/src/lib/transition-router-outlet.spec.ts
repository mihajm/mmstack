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
import { provideTransitionScope, registerResource } from '@mmstack/primitives';
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

    await router.navigateByUrl('/b/42');
    await flush();

    const routeA = container.querySelector('route-a') as HTMLElement | null;
    const routeB = container.querySelector('route-b') as HTMLElement | null;
    expect(routeA).not.toBeNull();
    expect(routeB).not.toBeNull();
    expect(routeB?.style.display).toBe('none');
    expect(routeB?.textContent).toContain('id=42');

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

    await router.navigateByUrl('/b/9');
    await flush();
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B id=9');
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

    const ok = await router.navigateByUrl('/b');
    await flush();
    expect(ok).toBe(false);
    expect(container.textContent).toContain('route-A');
    expect(container.querySelector('route-b')).toBeNull();
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
    expect(container.textContent).toContain('route-A');

    ref.status.set('error');
    await flush();
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
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

    void router.navigateByUrl('/b');
    await flush();
    expect(container.textContent).toContain('route-A');
    expect(container.querySelector('route-b')).toBeNull();

    resolveResolver(42);
    await flush();
    expect(container.textContent).toContain('route-A');

    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush();
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });

  it('works when NESTED: a child outlet inside a parent route still holds-and-swaps', async () => {
    @Component({ selector: 'child-one', template: `child-1` })
    class ChildOne {}
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

    await router.navigateByUrl('/p/c2');
    await flush();
    expect(container.textContent).toContain('parent:');
    expect(container.querySelector('child-one')).not.toBeNull();
    expect(container.querySelector('child-two')).not.toBeNull();

    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush();
    expect(container.querySelector('child-one')).toBeNull();
    expect(container.textContent).toContain('child-2');
    expect(container.textContent).toContain('parent:');
  });

  it('CanDeactivate guards receive the REAL component instance (outlet stays activated)', async () => {
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

    await router.navigateByUrl('/b');
    await flush();
    expect(container.textContent).toContain('route-B');

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
    await router.navigateByUrl('/b');
    await flush();
    expect(container.querySelector('route-a')).not.toBeNull();

    await router.navigateByUrl('/c');
    await flush();

    const heldA = container.querySelector('route-a') as HTMLElement | null;
    expect(heldA).not.toBeNull();
    expect(heldA?.style.display).not.toBe('none');
    expect(container.querySelector('route-b')).toBeNull();
    const hiddenC = container.querySelector('route-c') as HTMLElement | null;
    expect(hiddenC).not.toBeNull();
    expect(hiddenC?.style.display).toBe('none');

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
      expect(startViewTransition).not.toHaveBeenCalled();

      ref.value.set({ ok: true });
      ref.status.set('resolved');
      await flush();

      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(container.querySelector('route-a')).toBeNull();
      expect(container.textContent).toContain('route-B');
    } finally {
      delete (document as any).startViewTransition;
    }
  });

  it('a deferred view-transition callback from an interrupted swap cannot destroy the re-targeted hold', async () => {
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
      selector: 'vt-race-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet viewTransition />`,
    })
    class RaceHost {}

    // A real browser defers the callback; capture instead of invoking so a nav can interleave.
    const callbacks: Array<() => void> = [];
    const startViewTransition = vi.fn((cb: () => void) => {
      callbacks.push(cb);
      return {};
    });
    (document as any).startViewTransition = startViewTransition;

    try {
      const refB = makeRef('loading');
      const refC = makeRef('loading');
      const { fixture, container } = await render(RaceHost, {
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

      refB.value.set({ ok: true });
      refB.status.set('resolved');
      await flush();
      expect(startViewTransition).toHaveBeenCalledTimes(1);
      const stale = callbacks[0];

      await router.navigateByUrl('/c');
      await flush();

      stale(); // b-swap's deferred callback fires late — must be a no-op
      fixture.detectChanges();

      expect(container.querySelector('route-a')).not.toBeNull();
      const c = container.querySelector('route-c') as HTMLElement;
      expect(c.style.display).toBe('none');

      refC.value.set({ ok: true });
      refC.status.set('resolved');
      await flush();
      callbacks[callbacks.length - 1]();
      await flush();

      expect(container.querySelector('route-a')).toBeNull();
      expect(
        (container.querySelector('route-c') as HTMLElement).style.display,
      ).not.toBe('none');
    } finally {
      delete (document as any).startViewTransition;
    }
  });
});

describe('TransitionRouterOutlet — per-view attribution', () => {
  const A_REF = new InjectionToken<FakeRef>('attr-a-ref');
  const C_REF = new InjectionToken<FakeRef>('attr-c-ref');

  @Component({ selector: 'route-a', template: `route-A` })
  class RA {
    constructor() {
      registerResource(inject(A_REF), { suspends: false });
    }
  }
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
  @Component({ selector: 'route-n', template: `route-N` })
  class RN {}
  @Component({
    selector: 'attr-host',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet />`,
  })
  class AttrHost {}

  const flush = async (fixture: { detectChanges: () => void }) => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  async function setup(refs: { a: FakeRef; b: FakeRef; c?: FakeRef }) {
    const rendered = await render(AttrHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA },
          { path: 'b', component: RB },
          { path: 'c', component: RC },
          { path: 'n', component: RN },
        ]),
        provideLocationMocks(),
        { provide: A_REF, useValue: refs.a },
        { provide: B_REF, useValue: refs.b },
        { provide: C_REF, useValue: refs.c ?? makeRef('resolved') },
      ],
    });
    return { ...rendered, router: TestBed.inject(Router) };
  }

  it('a background poll on the held view does not block the swap', async () => {
    const a = makeRef('loading');
    const b = makeRef('loading');
    const { fixture, container, router } = await setup({ a, b });

    await router.navigateByUrl('/a');
    await flush(fixture);
    a.value.set({ ok: true });
    a.status.set('resolved');
    await flush(fixture);

    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(container.querySelector('route-a')).not.toBeNull();

    a.status.set('reloading');
    b.value.set({ ok: true });
    b.status.set('resolved');
    await flush(fixture);

    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });

  it('an outgoing ref toggling loading→resolved does not prematurely trip the swap', async () => {
    const a = makeRef('resolved');
    const b = makeRef('loading');
    const { fixture, container, router } = await setup({ a, b });

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(container.querySelector('route-a')).not.toBeNull();

    a.status.set('loading');
    await flush(fixture);
    a.status.set('resolved');
    await flush(fixture);

    expect(container.querySelector('route-a')).not.toBeNull();
    expect(
      (container.querySelector('route-b') as HTMLElement | null)?.style.display,
    ).toBe('none');

    b.value.set({ ok: true });
    b.status.set('resolved');
    await flush(fixture);
    expect(container.querySelector('route-a')).toBeNull();
  });

  it('a no-async incoming route swaps via the fallback even while the outgoing polls', async () => {
    const a = makeRef('loading');
    const b = makeRef('loading');
    const { fixture, container, router } = await setup({ a, b });

    await router.navigateByUrl('/a');
    await flush(fixture);
    a.status.set('reloading');

    await router.navigateByUrl('/n');
    await flush(fixture);

    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-N');
  });

  it('interrupt mid-hold: a poll on the held view does not affect the re-targeted swap', async () => {
    const a = makeRef('resolved');
    const b = makeRef('loading');
    const c = makeRef('loading');
    const { fixture, container, router } = await setup({ a, b, c });

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    a.status.set('reloading');

    await router.navigateByUrl('/c');
    await flush(fixture);
    expect(container.querySelector('route-a')).not.toBeNull();
    expect(container.querySelector('route-b')).toBeNull();
    expect(
      (container.querySelector('route-c') as HTMLElement | null)?.style.display,
    ).toBe('none');

    c.value.set({ ok: true });
    c.status.set('resolved');
    await flush(fixture);
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-C');
  });
});

describe('TransitionRouterOutlet — per-route scopes (opt-in)', () => {
  const A_REF = new InjectionToken<FakeRef>('rs-a-ref');

  @Component({ selector: 'route-a', template: `route-A` })
  class RA {
    constructor() {
      registerResource(inject(A_REF), { suspends: false });
    }
  }
  @Component({ selector: 'route-b', template: `route-B` })
  class RB {
    constructor() {
      registerResource(inject(B_REF), { suspends: false });
    }
  }
  @Component({
    selector: 'rs-host',
    imports: [TransitionRouterOutlet],
    template: `<mm-transition-outlet />`,
  })
  class RsHost {}

  const flush = async (fixture: { detectChanges: () => void }) => {
    for (let i = 0; i < 6; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  async function setup(a: FakeRef, b: FakeRef) {
    const rendered = await render(RsHost, {
      providers: [
        provideRouter([
          { path: 'a', component: RA, providers: [provideTransitionScope()] },
          { path: 'b', component: RB, providers: [provideTransitionScope()] },
        ]),
        provideLocationMocks(),
        { provide: A_REF, useValue: a },
        { provide: B_REF, useValue: b },
      ],
    });
    return { ...rendered, router: TestBed.inject(Router) };
  }

  it('holds until the incoming route scope settles (forwarder delegates reads to it)', async () => {
    const a = makeRef('resolved');
    const b = makeRef('loading');
    const { fixture, container, router } = await setup(a, b);

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(container.querySelector('route-a')).not.toBeNull();

    b.value.set({ ok: true });
    b.status.set('resolved');
    await flush(fixture);
    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });

  it('a poll on the held view (its own scope) cannot block the swap — isolation, not attribution', async () => {
    const a = makeRef('resolved');
    const b = makeRef('loading');
    const { fixture, container, router } = await setup(a, b);

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);

    a.status.set('reloading');
    b.value.set({ ok: true });
    b.status.set('resolved');
    await flush(fixture);

    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });
});

// Controllable fake of the DOM `ViewTransition`: `finished` settles only when we resolve it.
function deferredTransition() {
  let resolveFinished!: () => void;
  let rejectFinished!: (e?: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  finished.catch(() => undefined);
  return {
    skipTransition: vi.fn(),
    finished,
    // Angular's createViewTransition attaches `.catch` to all three.
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
  // Immediate (no-hold) route that still loads: Angular animates it, not the outlet.
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

    coordinator.enabled = true;

    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(startViewTransition).not.toHaveBeenCalled();

    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
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

    expect(startViewTransition).not.toHaveBeenCalled();
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

    expect(startViewTransition).toHaveBeenCalledTimes(1);
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

    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("skips Angular's inert activation-time transition while holding", async () => {
    const { fixture, coordinator, router } = await setup(DefaultHost);

    await router.navigateByUrl('/a');
    await flush(fixture);

    const t = deferredTransition();
    coordinator.enabled = true;
    coordinator.active = t;

    await router.navigateByUrl('/b');
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

    await router.navigateByUrl('/i');
    await flush(fixture);

    expect(t.skipTransition).not.toHaveBeenCalled();
  });

  it('does not throw when holding with no active router transition', async () => {
    const { fixture, ref, router, coordinator } = await setup(DefaultHost);
    coordinator.enabled = true;
    coordinator.active = null;

    await router.navigateByUrl('/a');
    await flush(fixture);
    await router.navigateByUrl('/b');
    await flush(fixture);
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(fixture).toBeTruthy();
  });

  it('skips each navigation’s own transition exactly once across successive holds', async () => {
    const { fixture, ref, router, coordinator } = await setup(DefaultHost);
    coordinator.enabled = true;

    await router.navigateByUrl('/a');
    await flush(fixture);

    const tB = deferredTransition();
    coordinator.active = tB;
    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(tB.skipTransition).toHaveBeenCalledTimes(1);

    // clear `active` before returning to /a so this held nav doesn't consume a skip on tB
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);
    coordinator.active = null;
    ref.status.set('loading');
    ref.value.set(undefined);
    await router.navigateByUrl('/a');
    await flush(fixture);

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
    expect(coordinator.active).toBeNull();
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

    t1.resolveFinished();
    await t1.finished;
    await Promise.resolve();
    expect(coordinator.active).toBe(t2);

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

    expect(coordinator.enabled).toBe(true);
    expect(created.length).toBeGreaterThan(0);
  });

  it('on a held navigation, Angular creates the transition and the outlet skips it', async () => {
    const { fixture, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    const before = created.length;
    await router.navigateByUrl('/b');
    await flush(fixture);

    expect(created.length).toBe(before + 1);
    expect(created[created.length - 1].skipTransition).toHaveBeenCalledTimes(1);
  });

  it('a guard-denied navigation creates no transition (no stale active leaks)', async () => {
    const { fixture, coordinator, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    created.forEach((t) => t.resolveFinished());
    await flush(fixture);
    expect(coordinator.active).toBeNull();

    const before = created.length;
    const ok = await router.navigateByUrl('/denied');
    await flush(fixture);

    expect(ok).toBe(false);
    expect(created.length).toBe(before);
    expect(coordinator.active).toBeNull();
  });

  it('a redirect produces a single committed transition and lands on the target', async () => {
    const { fixture, router, created } = await setup();
    await router.navigateByUrl('/b');
    await flush(fixture);

    const before = created.length;
    await router.navigateByUrl('/redirect');
    await flush(fixture);

    expect(router.url).toBe('/a');
    // one transition for the committed navigation, not one per hop
    expect(created.length).toBe(before + 1);
  });

  it('hands the transition off: Angular’s is skipped at activation, the outlet fires its OWN at the swap', async () => {
    const { fixture, container, ref, router, created } = await setup();
    await router.navigateByUrl('/a');
    await flush(fixture);

    await router.navigateByUrl('/b');
    await flush(fixture);
    const angulars = created[created.length - 1];
    expect(angulars.skipTransition).toHaveBeenCalledTimes(1);
    expect(container.querySelector('route-ia')).not.toBeNull();

    const before = created.length;
    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(created.length).toBe(before + 1);
    expect(created[created.length - 1].skipTransition).not.toHaveBeenCalled();
    expect(container.querySelector('route-ia')).toBeNull();
    expect(container.querySelector('route-ib')).not.toBeNull();
    expect(
      (container.querySelector('route-ib') as HTMLElement).style.display,
    ).not.toBe('none');
  });
});
