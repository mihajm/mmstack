import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  DestroyRef,
  EnvironmentInjector,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
  type DetachedRouteHandle,
  provideRouter,
  type Route,
  Router,
  RouteReuseStrategy,
  type Routes,
  withAutoCleanupInjectors,
} from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import {
  AUTO_CLEANUP_WITHOUT_STRATEGY,
  HELD_INJECTOR_DESTROYED,
  provideTransitionRouteReuseStrategy,
} from './transition-route-reuse-strategy';
import { TransitionRouterOutlet } from './transition-router-outlet';

const B_STATUS = signal<ResourceStatus>('loading');
const fakeRef = () =>
  ({
    status: B_STATUS,
    value: signal(undefined),
    isLoading: computed(() => B_STATUS() === 'loading'),
    hasValue: () => false,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  }) as unknown as ResourceRef<unknown>;

let envA: EnvironmentInjector | null = null;
const TOKEN = new InjectionToken<string>('a-token');

@Component({ selector: 'page-a', template: `A` })
class PageA {
  constructor() {
    envA = inject(EnvironmentInjector);
  }
}
@Component({ selector: 'page-b', template: `B` })
class PageB {
  constructor() {
    registerResource(fakeRef(), { suspends: false });
  }
}
@Component({ selector: 'page-c', template: `C` })
class PageC {}

@Component({
  selector: 'strategy-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet /><mm-transition-outlet name="side" />`,
})
class Host {}

const routes: Routes = [
  {
    path: 'a',
    component: PageA,
    providers: [{ provide: TOKEN, useValue: 'a' }],
  },
  { path: 'b', component: PageB },
  { path: 'c', component: PageC },
];

async function run(opts: { autoCleanup: boolean; providers?: unknown[] }) {
  B_STATUS.set('loading');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { fixture } = await render(Host, {
    providers: [
      opts.autoCleanup
        ? provideRouter(routes, withAutoCleanupInjectors())
        : provideRouter(routes),
      provideLocationMocks(),
      ...((opts.providers ?? []) as never[]),
    ],
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
  };
  const router = TestBed.inject(Router);
  const warnedAtCreation = warn.mock.calls.map((c) => c[0]);
  await router.navigateByUrl('/a');
  await flush();
  let destroyed = false;
  envA?.get(DestroyRef).onDestroy(() => (destroyed = true));
  await router.navigateByUrl('/b');
  await flush();
  const all = warn.mock.calls.map((c) => c[0]);
  warn.mockRestore();
  return { warnedAtCreation, all, destroyed: () => destroyed, router, flush };
}

describe('provideTransitionRouteReuseStrategy: dev warnings', () => {
  it('auto-cleanup without the strategy warns once at outlet creation and once at the guard', async () => {
    const r = await run({ autoCleanup: true });
    expect(r.warnedAtCreation).toEqual([AUTO_CLEANUP_WITHOUT_STRATEGY]);
    expect(r.destroyed()).toBe(true);
    expect(r.all).toEqual([
      AUTO_CLEANUP_WITHOUT_STRATEGY,
      HELD_INJECTOR_DESTROYED,
    ]);
  });

  it('auto-cleanup with the strategy keeps the held injector and says nothing', async () => {
    const r = await run({
      autoCleanup: true,
      providers: [provideTransitionRouteReuseStrategy()],
    });
    expect(r.destroyed()).toBe(false);
    expect(r.all).toEqual([]);
  });

  it('with the strategy, a held injector destroyed by other means does not warn', async () => {
    const r = await run({
      autoCleanup: true,
      providers: [provideTransitionRouteReuseStrategy()],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    envA?.destroy();
    await r.flush();
    expect(r.destroyed()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('without auto-cleanup there is nothing to warn about', async () => {
    const r = await run({ autoCleanup: false });
    expect(r.destroyed()).toBe(false);
    expect(r.all).toEqual([]);
  });
});

class AppStrategy extends BaseRouteReuseStrategy {
  readonly calls: string[] = [];
  override shouldDetach(): boolean {
    this.calls.push('shouldDetach');
    return false;
  }
  override shouldAttach(): boolean {
    this.calls.push('shouldAttach');
    return false;
  }
  override retrieve(): DetachedRouteHandle | null {
    this.calls.push('retrieve');
    return null;
  }
  override store(): void {
    this.calls.push('store');
  }
  override shouldReuseRoute(
    f: ActivatedRouteSnapshot,
    c: ActivatedRouteSnapshot,
  ): boolean {
    this.calls.push('shouldReuseRoute');
    return f.routeConfig === c.routeConfig;
  }
  retrieveStoredRouteHandles(): DetachedRouteHandle[] {
    return ['handle' as unknown as DetachedRouteHandle];
  }
  override shouldDestroyInjector(route: Route): boolean {
    return route.path !== 'a';
  }
}

describe('provideTransitionRouteReuseStrategy: an app strategy as inner', () => {
  it('forwards every decision to the app strategy', () => {
    const app = new AppStrategy();
    TestBed.configureTestingModule({
      providers: [provideTransitionRouteReuseStrategy(() => app)],
    });
    const strategy = TestBed.inject(
      RouteReuseStrategy,
    ) as RouteReuseStrategy & {
      retrieveStoredRouteHandles(): unknown[];
      shouldDestroyInjector(r: Route): boolean;
    };
    const snap = { routeConfig: null } as ActivatedRouteSnapshot;
    strategy.shouldDetach(snap);
    strategy.store(snap, null);
    strategy.shouldAttach(snap);
    strategy.retrieve(snap);
    expect(strategy.shouldReuseRoute(snap, snap)).toBe(true);
    expect(app.calls).toEqual([
      'shouldDetach',
      'store',
      'shouldAttach',
      'retrieve',
      'shouldReuseRoute',
    ]);
    expect(strategy.retrieveStoredRouteHandles()).toEqual(['handle']);
    expect(strategy.shouldDestroyInjector({ path: 'a' })).toBe(false);
    expect(strategy.shouldDestroyInjector({ path: 'x' })).toBe(true);
  });

  it("respects the app strategy's shouldDestroyInjector for routes that are not held", async () => {
    const r = await run({
      autoCleanup: true,
      providers: [provideTransitionRouteReuseStrategy(() => new AppStrategy())],
    });
    B_STATUS.set('resolved');
    await r.flush();
    await r.router.navigateByUrl('/c');
    await r.flush();
    expect(r.destroyed()).toBe(false);
  });

  it('the default inner destroys a released route on the next cleanup pass', async () => {
    const r = await run({
      autoCleanup: true,
      providers: [provideTransitionRouteReuseStrategy()],
    });
    B_STATUS.set('resolved');
    await r.flush();
    await r.router.navigateByUrl('/c');
    await r.flush();
    expect(r.destroyed()).toBe(true);
  });
});
