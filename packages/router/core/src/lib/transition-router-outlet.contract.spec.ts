import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  DestroyRef,
  EnvironmentInjector,
  ErrorHandler,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type Type,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type DetachedRouteHandle,
  provideRouter,
  Router,
  RouteReuseStrategy,
  type Routes,
  withExperimentalAutoCleanupInjectors,
} from '@angular/router';
import { provideTransitionScope, registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { provideTransitionRouteReuseStrategy } from './transition-route-reuse-strategy';
import { TransitionRouterOutlet } from './transition-router-outlet';
import {
  mmRouterViewTransitions,
  RouterViewTransitions,
} from './view-transition';
import { injectVisualCommit } from './visual-commit';

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

const REFS = new InjectionToken<Record<string, FakeRef>>('test-refs');
const envs: Record<string, EnvironmentInjector> = {};

function track(name: string) {
  envs[name] = inject(EnvironmentInjector);
  const ref = inject(REFS)[name];
  if (ref) registerResource(ref, { suspends: false });
}

@Component({ selector: 'page-a', template: `A` })
class PageA {
  constructor() {
    track('a');
  }
}
@Component({ selector: 'page-b', template: `B` })
class PageB {
  constructor() {
    track('b');
  }
}
@Component({ selector: 'page-c', template: `C` })
class PageC {
  constructor() {
    track('c');
  }
}
@Component({ selector: 'page-q', template: `Q` })
class PageQ {
  constructor() {
    track('q');
  }
}
@Component({ selector: 'child-one', template: `C1` })
class ChildOne {
  constructor() {
    track('c1');
  }
}
@Component({ selector: 'child-two', template: `C2` })
class ChildTwo {
  constructor() {
    track('c2');
  }
}
@Component({
  selector: 'parent-p',
  imports: [TransitionRouterOutlet],
  template: `P:<mm-transition-outlet
      (swapCommit)="outcomes.push($event.outcome)"
    />`,
})
class ParentP {
  readonly outcomes: string[] = [];
  constructor() {
    track('p');
  }
}

@Component({
  selector: 'contract-host',
  imports: [TransitionRouterOutlet],
  template: `@if (show()) {
    <mm-transition-outlet
      (swapCommit)="outcomes.push($event.outcome)"
      (deactivate)="deactivated.push($event)"
    />
  }`,
})
class ContractHost {
  readonly show = signal(true);
  readonly outcomes: string[] = [];
  readonly deactivated: unknown[] = [];
}

async function setup(
  routes: Routes,
  refs: Record<string, FakeRef> = {},
  providers: unknown[] = [],
  host: Type<unknown> = ContractHost,
  autoCleanup = false,
) {
  for (const k of Object.keys(envs)) delete envs[k];
  const rendered = await render(host, {
    providers: [
      autoCleanup
        ? provideRouter(routes, withExperimentalAutoCleanupInjectors())
        : provideRouter(routes),
      provideLocationMocks(),
      { provide: REFS, useValue: refs },
      ...(providers as never[]),
    ],
  });
  const fixture = rendered.fixture;
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };
  const commit = TestBed.runInInjectionContext(() => injectVisualCommit());
  return {
    fixture,
    container: rendered.container as HTMLElement,
    router: TestBed.inject(Router),
    host: fixture.componentInstance as ContractHost,
    flush,
    commit,
  };
}

const el = (c: HTMLElement, sel: string) =>
  c.querySelector(sel) as HTMLElement | null;

const flat: Routes = [
  { path: 'a', component: PageA },
  { path: 'b', component: PageB },
  { path: 'c', component: PageC },
];

const nested: Routes = [
  {
    path: 'p',
    component: ParentP,
    children: [
      { path: 'c1', component: ChildOne },
      { path: 'c2', component: ChildTwo },
    ],
  },
  { path: 'q', component: PageQ },
];

describe('TransitionRouterOutlet contract: arming', () => {
  it('an activation replaced before its first render cannot settle the hold that replaced it', async () => {
    const b = makeRef('loading');
    const s = await setup(flat, { b });

    await s.router.navigateByUrl('/a');
    await s.router.navigateByUrl('/b');
    await s.flush();

    expect(s.commit().status).toBe('pending');
    expect(el(s.container, 'page-a')).not.toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('none');

    b.status.set('resolved');
    await s.flush();
    expect(s.commit().status).toBe('committed');
    expect(el(s.container, 'page-a')).toBeNull();
    expect(s.host.outcomes).toEqual(['committed']);
  });
});

describe('TransitionRouterOutlet contract: nested holds', () => {
  it('a held parent keeps its child view until the parent swaps (/p/c1 to /q)', async () => {
    const q = makeRef('loading');
    const s = await setup(nested, { q });

    await s.router.navigateByUrl('/p/c1');
    await s.flush();
    expect(el(s.container, 'child-one')).not.toBeNull();

    await s.router.navigateByUrl('/q');
    await s.flush();
    expect(el(s.container, 'parent-p')).not.toBeNull();
    expect(el(s.container, 'child-one')).not.toBeNull();
    expect(el(s.container, 'page-q')?.style.display).toBe('none');

    q.status.set('resolved');
    await s.flush();
    expect(el(s.container, 'parent-p')).toBeNull();
    expect(el(s.container, 'child-one')).toBeNull();
    expect(el(s.container, 'page-q')?.style.display).toBe('');
  });
});

describe('TransitionRouterOutlet contract: auto-cleanup injectors', () => {
  const TOKEN = new InjectionToken<string>('route-a-token');
  const scoped: Routes = [
    {
      path: 'a',
      component: PageA,
      providers: [{ provide: TOKEN, useValue: 'a' }],
    },
    { path: 'b', component: PageB },
    { path: 'c', component: PageC },
  ];

  it('with the hold-aware strategy, keeps the held route injector alive until the swap', async () => {
    const b = makeRef('loading');
    const s = await setup(
      scoped,
      { b },
      [provideTransitionRouteReuseStrategy()],
      ContractHost,
      true,
    );

    await s.router.navigateByUrl('/a');
    await s.flush();
    const envA = envs['a'];
    let destroyed = false;
    envA.get(DestroyRef).onDestroy(() => (destroyed = true));

    await s.router.navigateByUrl('/b');
    await s.flush();
    expect(destroyed).toBe(false);
    expect(s.commit().status).toBe('pending');
    expect(el(s.container, 'page-a')).not.toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('none');

    b.status.set('resolved');
    await s.flush();
    expect(s.host.outcomes.at(-1)).toBe('committed');
    expect(el(s.container, 'page-a')).toBeNull();

    await s.router.navigateByUrl('/c');
    await s.flush();
    expect(destroyed).toBe(true);
  });
});

describe('TransitionRouterOutlet contract: held injector guard', () => {
  const TOKEN = new InjectionToken<string>('route-a-token');
  const scoped: Routes = [
    {
      path: 'a',
      component: PageA,
      providers: [{ provide: TOKEN, useValue: 'a' }],
    },
    { path: 'b', component: PageB },
  ];

  it('commits at once when the held view injector is destroyed under it', async () => {
    const b = makeRef('loading');
    const s = await setup(scoped, { b });

    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    expect(el(s.container, 'page-a')).not.toBeNull();

    envs['a'].destroy();
    await s.flush();
    expect(el(s.container, 'page-a')).toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('');
    expect(s.host.outcomes.at(-1)).toBe('committed');
    expect(s.commit().status).toBe('committed');
  });
});

describe('TransitionRouterOutlet contract: lifecycle events', () => {
  it('emits deactivate for the held view only when it is finally destroyed', async () => {
    const b = makeRef('loading');
    const s = await setup(flat, { b });

    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    expect(s.host.deactivated).toEqual([]);

    b.status.set('resolved');
    await s.flush();
    expect(s.host.deactivated).toHaveLength(1);
    expect(s.host.deactivated[0]).toBeInstanceOf(PageA);
  });

  it('an outlet destroyed mid-hold emits deactivate once and releases the visual commit', async () => {
    const b = makeRef('loading');
    const s = await setup(flat, { b });

    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    expect(s.commit().status).toBe('pending');

    s.host.show.set(false);
    await s.flush();
    expect(s.host.deactivated).toHaveLength(1);
    expect(s.host.deactivated[0]).toBeInstanceOf(PageA);
    expect(s.host.outcomes).toEqual(['immediate', 'outlet-destroyed']);
    expect(s.commit().status).toBe('committed');
  });

  it('an outlet destroyed while not holding does not report outlet-destroyed', async () => {
    const s = await setup(flat);

    await s.router.navigateByUrl('/a');
    await s.flush();
    s.host.show.set(false);
    await s.flush();
    expect(s.host.outcomes).toEqual(['immediate']);
  });

  it('a re-created outlet renders the next route', async () => {
    const s = await setup(flat);

    await s.router.navigateByUrl('/a');
    await s.flush();
    s.host.show.set(false);
    await s.flush();
    await s.router.navigateByUrl('/c');
    await s.flush();
    s.host.show.set(true);
    await s.flush();
    expect(el(s.container, 'page-c')).not.toBeNull();
    expect(el(s.container, 'page-a')).toBeNull();
  });

  it('a mid-hold deactivation with no activation drops both child views (/p/c1, /p/c2, /p)', async () => {
    const c2 = makeRef('loading');
    const s = await setup(nested, { c2 });

    await s.router.navigateByUrl('/p/c1');
    await s.flush();
    await s.router.navigateByUrl('/p/c2');
    await s.flush();
    expect(el(s.container, 'child-one')).not.toBeNull();

    await s.router.navigateByUrl('/p');
    await s.flush();
    expect(el(s.container, 'child-one')).toBeNull();
    expect(el(s.container, 'child-two')).toBeNull();
    expect(el(s.container, 'parent-p')).not.toBeNull();
    expect(s.commit().status).toBe('committed');
  });
});

describe('TransitionRouterOutlet contract: what counts as pending', () => {
  it('an incoming resource that starts reloading holds the swap', async () => {
    const b = makeRef('reloading');
    const s = await setup(flat, { b });

    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    expect(el(s.container, 'page-a')).not.toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('none');

    b.status.set('resolved');
    await s.flush();
    expect(el(s.container, 'page-a')).toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('');
  });

  it('an incoming resource that starts loading after the arm still releases the hold when it settles', async () => {
    const b = makeRef('idle');
    const s = await setup(flat, { b });

    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    b.status.set('loading');
    await s.flush();
    expect(el(s.container, 'page-a')).not.toBeNull();

    b.status.set('resolved');
    await s.flush();
    expect(el(s.container, 'page-a')).toBeNull();
    expect(el(s.container, 'page-b')?.style.display).toBe('');
  });

  it('a reload in a parent route scope does not block a nested swap whose routes do not opt in', async () => {
    const p = makeRef('resolved');
    const c2 = makeRef('loading');
    const s = await setup(
      [
        {
          path: 'p',
          component: ParentP,
          providers: [provideTransitionScope()],
          children: [
            { path: 'c1', component: ChildOne },
            { path: 'c2', component: ChildTwo },
          ],
        },
      ],
      { p, c2 },
    );

    await s.router.navigateByUrl('/p/c1');
    await s.flush();
    await s.router.navigateByUrl('/p/c2');
    await s.flush();
    p.status.set('reloading');
    await s.flush();
    expect(el(s.container, 'child-one')).not.toBeNull();

    c2.status.set('resolved');
    await s.flush();
    expect(el(s.container, 'child-one')).toBeNull();
    expect(el(s.container, 'child-two')?.style.display).toBe('');
  });
});

@Component({
  selector: 'named-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet [name]="name()" />`,
})
class NamedHost {
  readonly name = signal('one');
}

describe('TransitionRouterOutlet contract: edges', () => {
  it('renaming an outlet that has no active route does not throw', async () => {
    const s = await setup(flat, {}, [], NamedHost);
    await s.router.navigateByUrl('/a');
    await s.flush();

    (s.fixture.componentInstance as NamedHost).name.set('two');
    expect(() => s.fixture.detectChanges()).not.toThrow();
  });

  it('a deactivation with no activation before the first render reports no error', async () => {
    const errors: unknown[] = [];
    const s = await setup(
      [
        ...flat,
        { path: 'none', children: [] },
        { path: 'blocked', component: PageC, canActivate: [() => false] },
      ],
      {},
      [
        {
          provide: ErrorHandler,
          useValue: { handleError: (e: unknown) => errors.push(e) },
        },
      ],
    );
    await s.router.navigateByUrl('/a');
    await s.router.navigateByUrl('/none');
    await s.flush();
    expect(errors).toEqual([]);
    expect(el(s.container, 'page-a')).toBeNull();
    expect(s.commit().status).toBe('committed');

    await s.router.navigateByUrl('/blocked');
    await s.flush();
    expect(s.commit()).toEqual({ status: 'idle', navigationId: null });
  });

  it('a deferred view-transition swap reports committed once', async () => {
    const callbacks: Array<() => void> = [];
    const doc = document as unknown as Record<string, unknown>;
    doc['startViewTransition'] = (cb: () => void) => {
      callbacks.push(cb);
      return {};
    };
    try {
      const b = makeRef('loading');
      const s = await setup(flat, { b }, [], VtHost);
      await s.router.navigateByUrl('/a');
      await s.flush();
      await s.router.navigateByUrl('/b');
      await s.flush();

      b.status.set('resolved');
      await s.flush();
      b.status.set('loading');
      await s.flush();
      b.status.set('resolved');
      await s.flush();
      expect(callbacks.length).toBe(2);

      for (const cb of callbacks) cb();
      await s.flush();
      const outcomes = (s.fixture.componentInstance as VtHost).outcomes;
      expect(outcomes.filter((o) => o === 'committed')).toHaveLength(1);
      expect(el(s.container, 'page-a')).toBeNull();
    } finally {
      delete doc['startViewTransition'];
    }
  });
});

@Component({
  selector: 'vt-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet
    viewTransition
    (swapCommit)="outcomes.push($event.outcome)"
  />`,
})
class VtHost {
  readonly outcomes: string[] = [];
}

class StoreA implements RouteReuseStrategy {
  private stored: DetachedRouteHandle | null = null;
  constructor(private detachLimit = Infinity) {}
  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    if (route.routeConfig?.path !== 'a' || this.detachLimit <= 0) return false;
    this.detachLimit--;
    return true;
  }
  store(_: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
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

describe('TransitionRouterOutlet contract: reuse strategy', () => {
  const TOKEN = new InjectionToken<string>('route-a-token');
  const reuse: Routes = [
    {
      path: 'a',
      component: PageA,
      providers: [{ provide: TOKEN, useValue: 'a' }],
    },
    { path: 'b', component: PageB },
    { path: 'c', component: PageC },
  ];
  const strategy = (limit?: number) => [
    { provide: RouteReuseStrategy, useValue: new StoreA(limit) },
  ];

  it('a re-attached view reports immediate', async () => {
    const s = await setup(reuse, {}, strategy());
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    await s.router.navigateByUrl('/a');
    await s.flush();
    expect(el(s.container, 'page-a')).not.toBeNull();
    expect(s.host.outcomes).toEqual(['immediate', 'immediate', 'immediate']);
    expect(s.commit().status).toBe('committed');
  });

  it('a re-attached view that is then held is guarded by its own injector', async () => {
    const c = makeRef('loading');
    const s = await setup(reuse, { c }, strategy(1));
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/c');
    await s.flush();
    expect(el(s.container, 'page-a')).not.toBeNull();

    envs['a'].destroy();
    await s.flush();
    expect(el(s.container, 'page-a')).toBeNull();
    expect(s.host.outcomes.at(-1)).toBe('committed');
  });
});

describe('mmRouterViewTransitions contract', () => {
  it('options without a callback of their own do not throw', () => {
    TestBed.configureTestingModule({});
    const options = mmRouterViewTransitions({ skipInitialTransition: true });
    expect(options.skipInitialTransition).toBe(true);
    const info = {
      transition: {
        finished: Promise.resolve(),
        skipTransition: () => undefined,
      },
      from: {},
      to: {},
    } as never;
    expect(() =>
      TestBed.runInInjectionContext(() =>
        options.onViewTransitionCreated?.(info),
      ),
    ).not.toThrow();
    expect(TestBed.inject(RouterViewTransitions).enabled).toBe(true);
  });
});
