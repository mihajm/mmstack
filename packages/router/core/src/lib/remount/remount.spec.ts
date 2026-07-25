/* eslint-disable @angular-eslint/component-selector */
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  DestroyRef,
  inject,
  Injectable,
  NgModule,
  type OnDestroy,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  NavigationCancel,
  NavigationCancellationCode,
  PreloadAllModules,
  provideRouter,
  type Route,
  Router,
  RouterModule,
  RouterPreloader,
  type Routes,
  withPreloading,
} from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { PreloadRequester, PreloadStrategy } from '../preloading';
import { TransitionRouterOutlet } from '../transition-router-outlet';
import { loadedInjector } from './lazy-route-internals';
import { injectRemountHandle, remountable } from './remount';

@Component({ selector: 'eager-page', template: `eager` })
class EagerPage {}

@Component({ selector: 'feature-page', template: `feature:{{ tag }}` })
class FeaturePage {
  readonly tag = currentTag;
}

let currentTag = 'v1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Harness = {
  router: Router;
  loadCalls: () => number;
  releaseLoad: (routes: Route[]) => void;
  nextLoadIsDeferred: () => void;
  closeGate: () => void;
  openGate: () => void;
};

function setup(options?: { preload?: boolean; onDemand?: boolean }): Harness {
  let loadCalls = 0;
  let deferLoad = false;
  let pendingLoad = deferred<Route[]>();
  let gate: ReturnType<typeof deferred<boolean>> | null = null;

  const routes: Route[] = [
    { path: 'eager', component: EagerPage },
    {
      path: 'feature',
      data: { ...remountable('feature') },
      canMatch: [() => gate?.promise ?? true],
      loadChildren: () => {
        loadCalls++;
        if (!deferLoad)
          return Promise.resolve([
            { path: '', component: FeaturePage },
          ] satisfies Route[]);
        deferLoad = false;
        pendingLoad = deferred<Route[]>();
        return pendingLoad.promise;
      },
    },
  ];

  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        routes,
        ...(options?.preload ? [withPreloading(PreloadAllModules)] : []),
        ...(options?.onDemand ? [withPreloading(PreloadStrategy)] : []),
      ),
      provideLocationMocks(),
    ],
  });

  // `setUpPreloading` normally runs from the bootstrap listener, which TestBed never fires.
  if (options?.preload || options?.onDemand)
    TestBed.inject(RouterPreloader).setUpPreloading();

  return {
    router: TestBed.inject(Router),
    loadCalls: () => loadCalls,
    releaseLoad: (r) => pendingLoad.resolve(r),
    nextLoadIsDeferred: () => (deferLoad = true),
    closeGate: () => (gate = deferred<boolean>()),
    openGate: () => {
      gate?.resolve(true);
      gate = null;
    },
  };
}

/** Lives in the lazy subtree's own injector, so it dies exactly when that injector does. */
@Injectable()
class SubtreeScoped implements OnDestroy {
  static instances: SubtreeScoped[] = [];
  destroyed = false;
  constructor() {
    SubtreeScoped.instances.push(this);
  }
  ngOnDestroy() {
    this.destroyed = true;
  }
}

@Component({ selector: 'lazy-page', template: `lazy:{{ data.value() ?? '' }}` })
class LazyPage {
  readonly scoped = inject(SubtreeScoped);
  readonly data = httpResource<string>(() => '/api/lazy');
  constructor() {
    registerResource(this.data, { suspends: true });
  }
}

@Component({ selector: 'module-page', template: `module` })
class ModulePage {}

@NgModule({
  imports: [RouterModule.forChild([{ path: '', component: ModulePage }])],
})
class LazyFeatureModule {}

@Component({
  selector: 'remount-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class RemountHost {}

async function setupMounted(options?: { asModule?: boolean }) {
  SubtreeScoped.instances = [];
  const routes: Routes = [
    { path: 'eager', component: EagerPage },
    {
      path: 'lazy',
      data: { ...remountable('lazy') },
      loadChildren: () =>
        options?.asModule
          ? Promise.resolve(LazyFeatureModule)
          : Promise.resolve([
              {
                path: '',
                component: LazyPage,
                providers: [SubtreeScoped],
              },
            ] satisfies Routes),
    },
  ];

  const rendered = await render(RemountHost, {
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
    handle: TestBed.runInInjectionContext(() => injectRemountHandle('lazy')),
  };
}

const paint = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

const lazyRoute = (router: Router) =>
  router.config.find((r) => r.path === 'lazy') as Route;

/** The instance the current mount created — the one the next invalidation orphans. */
const currentScoped = () =>
  SubtreeScoped.instances[SubtreeScoped.instances.length - 1];

const handleOf = () =>
  TestBed.runInInjectionContext(() => injectRemountHandle('feature'));

const featureRoute = (router: Router) =>
  router.config.find((r) => r.path === 'feature') as Route;

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('remountable / injectRemountHandle', () => {
  it('drops the cached subtree, bumps generation and re-enters the current URL', async () => {
    const { router, loadCalls } = setup();
    const handle = handleOf();

    await router.navigateByUrl('/feature');
    expect(loadCalls()).toBe(1);
    expect(handle.generation()).toBe(0);

    currentTag = 'v2';
    const result = await handle.invalidate();

    expect(result).toEqual({ outcome: 'remounted' });
    expect(handle.generation()).toBe(1);
    expect(loadCalls()).toBe(2);
    expect(router.url).toBe('/feature');
  });

  it('the same handle is shared across injections', () => {
    setup();
    expect(handleOf()).toBe(handleOf());
  });

  it('`navigation: none` drops the cache without navigating', async () => {
    const { router, loadCalls } = setup();
    const handle = handleOf();

    await router.navigateByUrl('/feature');
    await router.navigateByUrl('/eager');
    expect(loadCalls()).toBe(1);

    expect(await handle.invalidate({ navigation: 'none' })).toEqual({
      outcome: 'remounted',
    });
    expect(router.url).toBe('/eager');
    expect(loadCalls()).toBe(1);

    await router.navigateByUrl('/feature');
    expect(loadCalls()).toBe(2);
  });

  it('resolves `no-op` — without bumping generation or navigating — when nothing was cached', async () => {
    const { router } = setup();
    const handle = handleOf();

    await router.navigateByUrl('/eager');
    const result = await handle.invalidate();

    expect(result).toEqual({ outcome: 'no-op' });
    expect(handle.generation()).toBe(0);
    expect(router.url).toBe('/eager');
  });

  it('throws a wiring error when no route carries the marker', async () => {
    setup();
    const handle = TestBed.runInInjectionContext(() =>
      injectRemountHandle('typo'),
    );
    await expect(handle.invalidate()).rejects.toThrow(
      /No route marked remountable\("typo"\)/,
    );
  });

  it('a preload that completes after invalidate() cannot repopulate the config', async () => {
    const { router, loadCalls, releaseLoad, nextLoadIsDeferred } = setup({
      preload: true,
    });
    const handle = handleOf();

    nextLoadIsDeferred();
    await router.navigateByUrl('/eager');
    await settle();
    expect(loadCalls()).toBe(1); // the preloader started the lazy load

    const staleRoute = featureRoute(router);
    expect(await handle.invalidate({ navigation: 'none' })).toEqual({
      outcome: 'no-op',
    });
    expect(featureRoute(router)).not.toBe(staleRoute);

    releaseLoad([{ path: '', component: EagerPage }]);
    await settle();

    // The stale load landed on the orphaned route object, not the live config.
    expect(
      (featureRoute(router) as Record<string, unknown>)['_loadedRoutes'],
    ).toBeUndefined();
    expect(
      (staleRoute as Record<string, unknown>)['_loadedRoutes'],
    ).toBeDefined();

    await router.navigateByUrl('/feature');
    expect(loadCalls()).toBe(2);
    expect(router.url).toBe('/feature');
  });

  // Invalidation makes the subtree factory-fresh, so warming has to work again.
  it('lets the preload strategy warm the subtree again after invalidate()', async () => {
    const { router, loadCalls } = setup({ onDemand: true });
    const handle = handleOf();
    const requester = TestBed.inject(PreloadRequester);

    await router.navigateByUrl('/eager');
    await settle();
    requester.startPreload('feature');
    await settle();
    expect(loadCalls()).toBe(1);
    expect(
      (featureRoute(router) as Record<string, unknown>)['_loadedRoutes'],
    ).toBeDefined();

    expect(await handle.invalidate()).toEqual({ outcome: 'remounted' });
    await settle();

    // A path that was warmed once is normally never warmed again; the invalidated one must be.
    requester.startPreload('feature');
    await settle();
    expect(loadCalls()).toBe(2);
    expect(
      (featureRoute(router) as Record<string, unknown>)['_loadedRoutes'],
    ).toBeDefined();
  });

  describe('inFlight policy (navigation suspended in canMatch of the same subtree)', () => {
    it('`reject` touches nothing', async () => {
      const { router, closeGate, openGate } = setup();
      const handle = handleOf();

      await router.navigateByUrl('/feature');
      await router.navigateByUrl('/eager');

      closeGate();
      const nav = router.navigateByUrl('/feature');
      await settle();

      const before = featureRoute(router);
      expect(await handle.invalidate({ inFlight: 'reject' })).toEqual({
        outcome: 'rejected',
      });
      expect(featureRoute(router)).toBe(before);
      expect(handle.generation()).toBe(0);

      openGate();
      await nav;
    });

    it('`wait` runs only after the in-flight navigation settles', async () => {
      const { router, closeGate, openGate, loadCalls } = setup();
      const handle = handleOf();

      await router.navigateByUrl('/feature');
      await router.navigateByUrl('/eager');

      closeGate();
      const nav = router.navigateByUrl('/feature');
      await settle();

      let settled = false;
      const invalidation = handle
        .invalidate({ inFlight: 'wait', navigation: 'none' })
        .then((r) => {
          settled = true;
          return r;
        });
      await settle();
      expect(settled).toBe(false);
      expect(handle.generation()).toBe(0);

      openGate();
      await nav;
      expect(await invalidation).toEqual({ outcome: 'remounted' });
      expect(handle.generation()).toBe(1);
      expect(loadCalls()).toBe(1);
    });

    it('`wait` coalesces queued invalidations into one run', async () => {
      const { router, closeGate, openGate } = setup();
      const handle = handleOf();

      await router.navigateByUrl('/feature');
      await router.navigateByUrl('/eager');

      closeGate();
      const nav = router.navigateByUrl('/feature');
      await settle();

      const first = handle.invalidate({ inFlight: 'wait', navigation: 'none' });
      const second = handle.invalidate({
        inFlight: 'wait',
        navigation: 'none',
      });
      const third = handle.invalidate({ inFlight: 'wait', navigation: 'none' });

      openGate();
      await nav;

      expect(await first).toEqual({ outcome: 'remounted' });
      expect(await second).toEqual({ outcome: 'remounted' });
      expect(await third).toEqual({ outcome: 'remounted' });
      expect(handle.generation()).toBe(1);
    });

    it('`cancel-and-retry` aborts the in-flight navigation, then invalidates', async () => {
      const { router, closeGate, openGate } = setup();
      const handle = handleOf();

      await router.navigateByUrl('/feature');
      await router.navigateByUrl('/eager');

      const cancels: NavigationCancel[] = [];
      router.events.subscribe((e) => {
        if (e instanceof NavigationCancel) cancels.push(e);
      });

      closeGate();
      const nav = router.navigateByUrl('/feature');
      await settle();

      const result = await handle.invalidate({
        inFlight: 'cancel-and-retry',
        navigation: 'none',
      });

      expect(await nav).toBe(false);
      expect(cancels.at(-1)?.code).toBe(NavigationCancellationCode.Aborted);
      expect(result).toEqual({ outcome: 'remounted' });
      expect(handle.generation()).toBe(1);

      openGate();
    });
  });
});

describe('invalidate() disposal of the orphaned subtree', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('destroys the orphan once the replacement is on screen, not at NavigationEnd', async () => {
    const { fixture, router, http, handle } = await setupMounted();

    await router.navigateByUrl('/lazy');
    await paint(fixture);
    http.expectOne('/api/lazy').flush('one');
    await paint(fixture);
    const orphaned = currentScoped();
    expect(orphaned.destroyed).toBe(false);

    await handle.invalidate();
    await paint(fixture);
    // The router is done and the replacement has loaded, but its view is still staged: the old
    // one is what the user is looking at, and it is still using this injector.
    expect(orphaned.destroyed).toBe(false);

    http.expectOne('/api/lazy').flush('two');
    await paint(fixture);
    expect(orphaned.destroyed).toBe(true);
    expect(currentScoped()).not.toBe(orphaned);
    expect(currentScoped().destroyed).toBe(false);

    // And again: the handle keeps disposing after the first round.
    const second = currentScoped();
    await handle.invalidate();
    await paint(fixture);
    http.expectOne('/api/lazy').flush('three');
    await paint(fixture);
    expect(second.destroyed).toBe(true);
    expect(currentScoped().destroyed).toBe(false);
  });

  it('destroys the loaded-module injector of the orphan', async () => {
    const { fixture, router, handle } = await setupMounted({ asModule: true });

    await router.navigateByUrl('/lazy');
    await paint(fixture);

    const injector = loadedInjector(lazyRoute(router));
    expect(injector).toBeDefined();
    let destroyed = false;
    injector?.get(DestroyRef).onDestroy(() => (destroyed = true));

    await handle.invalidate();
    await paint(fixture);

    expect(destroyed).toBe(true);
  });

  it('`navigation: none` keeps the orphan alive until a successor load commits', async () => {
    const { fixture, router, http, handle } = await setupMounted();

    await router.navigateByUrl('/lazy');
    await paint(fixture);
    http.expectOne('/api/lazy').flush('one');
    await paint(fixture);
    const orphaned = currentScoped();

    expect(await handle.invalidate({ navigation: 'none' })).toEqual({
      outcome: 'remounted',
    });
    await paint(fixture);
    // Nothing navigated: the view built from this injector is still mounted.
    expect(orphaned.destroyed).toBe(false);

    await router.navigateByUrl('/eager');
    await paint(fixture);
    // A commit is not enough on its own — no successor has loaded yet.
    expect(orphaned.destroyed).toBe(false);

    await router.navigateByUrl('/lazy');
    await paint(fixture);
    http.expectOne('/api/lazy').flush('two');
    await paint(fixture);
    expect(orphaned.destroyed).toBe(true);
  });

  it('destroys every orphan that piled up, at the one commit that follows', async () => {
    const { fixture, router, http, handle } = await setupMounted();

    await router.navigateByUrl('/lazy');
    await paint(fixture);
    http.expectOne('/api/lazy').flush('one');
    await paint(fixture);
    const first = currentScoped();
    await handle.invalidate({ navigation: 'none' });

    await router.navigateByUrl('/eager');
    await paint(fixture);
    expect(first.destroyed).toBe(false);

    // Load a second mount, then invalidate it while its view is still staged: two orphans, and
    // the commit that follows belongs to neither of them.
    await router.navigateByUrl('/lazy');
    await paint(fixture);
    const second = currentScoped();
    expect(second).not.toBe(first);
    await handle.invalidate({ navigation: 'none' });
    http.expectOne('/api/lazy').flush('two');
    await paint(fixture);
    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(false);

    await router.navigateByUrl('/eager');
    await paint(fixture);
    await router.navigateByUrl('/lazy');
    await paint(fixture);
    http.expectOne('/api/lazy').flush('three');
    await paint(fixture);

    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(true);
    expect(currentScoped().destroyed).toBe(false);
  });
});
