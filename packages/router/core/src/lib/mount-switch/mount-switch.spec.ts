/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import {
  type ActivatedRouteSnapshot,
  type DetachedRouteHandle,
  PreloadAllModules,
  provideRouter,
  type Route,
  Router,
  type RouterFeatures,
  RouterPreloader,
  RouteReuseStrategy,
  type Routes,
  withPreloading,
} from '@angular/router';
import { render } from '@testing-library/angular';
import { createTitle } from '../title/title-store';
import { TransitionRouterOutlet } from '../transition-router-outlet';
import { injectMountController, mountSwitchRoute } from './mount-switch';

@Component({ selector: 'page-home', template: `home` })
class PageHome {
  static instances = 0;
  readonly instance = ++PageHome.instances;
}

@Component({ selector: 'preview-v1', template: `V1` })
class PreviewV1 {}

@Component({ selector: 'preview-v2', template: `V2` })
class PreviewV2 {}

@Component({
  selector: 'mount-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class MountHost {}

type MountOptions = {
  variant: 'v1' | 'v2';
  block?: 'guard' | 'resolver';
};

function setup(initial?: Partial<MountOptions>) {
  const options: MountOptions = { variant: 'v1', ...initial };
  let loadCalls = 0;

  const mount = (): Route => ({
    path: 'preview',
    ...(options.block === 'guard' ? { canActivate: [() => false] } : {}),
    loadChildren: () => {
      loadCalls++;
      return Promise.resolve([
        {
          path: '',
          component: options.variant === 'v1' ? PreviewV1 : PreviewV2,
          resolve: {
            title: createTitle(options.variant === 'v1' ? 'V1' : 'V2'),
            ...(options.block === 'resolver'
              ? {
                  boom: () => {
                    throw new Error('resolver exploded');
                  },
                }
              : {}),
          },
        },
      ] satisfies Routes);
    },
  });

  const routes: Routes = [
    {
      path: 'home',
      component: PageHome,
      resolve: { title: createTitle('Home') },
    },
    mountSwitchRoute('preview', mount),
  ];

  return { routes, options, loadCalls: () => loadCalls };
}

async function renderWith(
  routes: Routes,
  extraProviders: unknown[] = [],
  features: RouterFeatures[] = [],
) {
  const rendered = await render(MountHost, {
    providers: [
      provideRouter(routes, ...features),
      provideLocationMocks(),
      ...(extraProviders as never[]),
    ],
  });
  return {
    ...rendered,
    router: TestBed.inject(Router),
    title: TestBed.inject(Title),
    controller: TestBed.runInInjectionContext(() =>
      injectMountController('preview'),
    ),
  };
}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

const mountRoute = (router: Router): Route =>
  router.config.find((r) => r.path === 'preview') as Route;

const loadedChildrenOf = (route: Route) =>
  (route as unknown as { _loadedRoutes?: Route[] })._loadedRoutes;

describe('mountSwitchRoute / injectMountController', () => {
  it('swaps the mount and commits on NavigationEnd', async () => {
    const { routes, options, loadCalls } = setup();
    const { fixture, container, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    expect(container.textContent).toContain('V1');
    expect(loadCalls()).toBe(1);

    options.variant = 'v2';
    const result = await controller.switch();
    await flush(fixture);

    expect(result).toEqual({ outcome: 'committed' });
    expect(container.textContent).toContain('V2');
    expect(loadCalls()).toBe(2);
  });

  it('throws when no route carries the mount marker', async () => {
    const { controller } = await renderWith([
      { path: 'home', component: PageHome },
    ]);
    expect(() => controller.switch()).toThrow(
      /No mountSwitchRoute\("preview"\)/,
    );
  });

  it('a guard-cancelled switch puts the previous mount back with its cache intact', async () => {
    const { routes, options } = setup();
    const { fixture, container, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    const cachedBefore = loadedChildrenOf(mountRoute(router));
    expect(cachedBefore).toBeDefined();

    options.variant = 'v2';
    options.block = 'guard';
    const result = await controller.switch();
    await flush(fixture);

    expect(result).toEqual({ outcome: 'rolled-back', reason: 'cancelled' });
    expect(container.textContent).toContain('V1');
    expect(router.url).toBe('/preview');
    // Same cached children array — the restore did not re-run the loader.
    expect(loadedChildrenOf(mountRoute(router))).toBe(cachedBefore);
  });

  it('an errored switch rolls back and drops the title it staged', async () => {
    const { routes, options } = setup();
    const { fixture, container, router, controller, title } =
      await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    expect(title.getTitle()).toBe('V1');

    options.variant = 'v2';
    options.block = 'resolver';
    const result = await controller.switch();
    await flush(fixture);

    expect(result).toEqual({ outcome: 'rolled-back', reason: 'error' });
    expect(container.textContent).toContain('V1');
    expect(title.getTitle()).toBe('V1');
  });

  it('keeps a RouteReuseStrategy handle detached under the old generation usable', async () => {
    const { routes, options } = setup();
    const stored = new Map<string, DetachedRouteHandle | null>();
    const key = (route: ActivatedRouteSnapshot) =>
      route.routeConfig?.path ?? '';

    class KeepHome implements RouteReuseStrategy {
      shouldDetach = (route: ActivatedRouteSnapshot) => key(route) === 'home';
      store = (
        route: ActivatedRouteSnapshot,
        handle: DetachedRouteHandle | null,
      ) => {
        stored.set(key(route), handle);
      };
      shouldAttach = (route: ActivatedRouteSnapshot) =>
        !!stored.get(key(route));
      retrieve = (route: ActivatedRouteSnapshot) =>
        stored.get(key(route)) ?? null;
      shouldReuseRoute = (
        future: ActivatedRouteSnapshot,
        curr: ActivatedRouteSnapshot,
      ) => future.routeConfig === curr.routeConfig;
    }

    const { fixture, container, router, controller } = await renderWith(
      routes,
      [{ provide: RouteReuseStrategy, useClass: KeepHome }],
    );

    await router.navigateByUrl('/home');
    await flush(fixture);
    const firstInstance = PageHome.instances;

    await router.navigateByUrl('/preview');
    await flush(fixture);
    expect(stored.get('home')).toBeTruthy();

    options.variant = 'v2';
    options.block = 'guard';
    expect(await controller.switch()).toEqual({
      outcome: 'rolled-back',
      reason: 'cancelled',
    });
    await flush(fixture);

    // The handle detached before the aborted switch is still the one that comes back.
    expect(stored.get('home')).toBeTruthy();
    options.block = undefined;
    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(container.textContent).toContain('home');
    expect(PageHome.instances).toBe(firstInstance);
  });

  it('a second switch supersedes the first, and the config never interleaves', async () => {
    const { routes, options } = setup();
    const { fixture, container, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    const seen: (Route | undefined)[] = [];

    options.variant = 'v2';
    const first = controller.switch();
    seen.push(mountRoute(router));
    const second = controller.switch();
    seen.push(mountRoute(router));

    expect(await first).toEqual({ outcome: 'superseded' });
    expect(await second).toEqual({ outcome: 'committed' });
    await flush(fixture);

    // Each begin() replaced the slot synchronously: two distinct mounts, in order, and the one
    // left standing is the second.
    expect(seen[0]).not.toBe(seen[1]);
    expect(mountRoute(router)).toBe(seen[1]);
    expect(container.textContent).toContain('V2');
  });

  it('an unrelated navigation that supersedes the switch rolls it back', async () => {
    const { routes, options } = setup();
    const { fixture, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    const live = mountRoute(router);

    options.variant = 'v2';
    const switching = controller.switch();
    await router.navigateByUrl('/home');

    expect(await switching).toEqual({
      outcome: 'rolled-back',
      reason: 'cancelled',
    });
    await flush(fixture);

    expect(router.url).toBe('/home');
    expect(loadedChildrenOf(mountRoute(router))).toBe(loadedChildrenOf(live));
  });

  it('rolling back after a supersession lands on the last mount that was live', async () => {
    const { routes, options } = setup();
    const { fixture, container, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    const live = mountRoute(router);

    options.variant = 'v2';
    const first = controller.switch();
    options.block = 'guard';
    const second = controller.switch();

    expect(await first).toEqual({ outcome: 'superseded' });
    expect(await second).toEqual({
      outcome: 'rolled-back',
      reason: 'cancelled',
    });
    await flush(fixture);

    expect(container.textContent).toContain('V1');
    expect(loadedChildrenOf(mountRoute(router))).toBe(loadedChildrenOf(live));
  });

  it('a guard redirect is a re-entry hop, not an abort: the switch still commits', async () => {
    let redirect = false;
    const routes: Routes = [
      { path: 'home', component: PageHome },
      mountSwitchRoute('preview', () => ({
        path: 'preview',
        canActivate: [
          () => (redirect ? TestBed.inject(Router).parseUrl('/home') : true),
        ],
        loadChildren: () =>
          Promise.resolve([
            { path: '', component: PreviewV1 },
          ] satisfies Routes),
      })),
    ];
    const { fixture, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);

    redirect = true;
    const result = await controller.switch();
    await flush(fixture);

    expect(result).toEqual({ outcome: 'committed' });
    expect(router.url).toBe('/home');
  });

  // A load that started under the old mount must not attach to the new one.
  it('a lazy load in flight when beginSwitch() runs never reaches the new mount', async () => {
    let staleLoad!: (routes: Routes) => void;
    let loadCalls = 0;
    let switched = false;

    const routes: Routes = [
      { path: 'home', component: PageHome },
      mountSwitchRoute('preview', () => ({
        path: 'preview',
        canMatch: [
          () => {
            if (switched) return true;
            switched = true;
            return TestBed.runInInjectionContext(() =>
              injectMountController('preview'),
            ).beginSwitch();
          },
        ],
        loadChildren: () => {
          loadCalls++;
          if (loadCalls > 1)
            return Promise.resolve([
              { path: '', component: PreviewV2 },
            ] satisfies Routes);
          return new Promise<Routes>((resolve) => (staleLoad = resolve));
        },
      })),
    ];

    const { fixture, container, router } = await renderWith(
      routes,
      [],
      [withPreloading(PreloadAllModules)],
    );
    // Normally wired by the bootstrap listener, which TestBed never fires.
    TestBed.inject(RouterPreloader).setUpPreloading();

    await router.navigateByUrl('/home');
    await flush(fixture);
    expect(loadCalls).toBe(1); // the preloader started the stale load
    const staleRoute = mountRoute(router);

    await router.navigateByUrl('/preview');
    await flush(fixture);
    expect(switched).toBe(true);
    expect(mountRoute(router)).not.toBe(staleRoute);
    expect(container.textContent).toContain('V2');

    staleLoad([{ path: '', component: PreviewV1 }]);
    await flush(fixture);

    expect(loadedChildrenOf(staleRoute)).toBeDefined();
    expect(loadedChildrenOf(mountRoute(router))?.[0].component).toBe(PreviewV2);
    expect(container.textContent).toContain('V2');
  });

  it('outcome() reports the transaction switch() is running', async () => {
    const { routes, options } = setup();
    const { fixture, router, controller } = await renderWith(routes);

    await router.navigateByUrl('/preview');
    await flush(fixture);

    options.variant = 'v2';
    const switching = controller.switch();
    const observed = controller.outcome();

    expect(await switching).toEqual({ outcome: 'committed' });
    expect(await observed).toEqual({ outcome: 'committed' });
  });

  it('a beginSwitch caller reads the commit through outcome()', async () => {
    const options: MountOptions = { variant: 'v2' };
    let switched = false;

    const routes: Routes = [
      { path: 'home', component: PageHome },
      mountSwitchRoute('preview', () => ({
        path: 'preview',
        canMatch: [
          () => {
            if (switched) return true;
            switched = true;
            return TestBed.runInInjectionContext(() =>
              injectMountController('preview'),
            ).beginSwitch();
          },
        ],
        loadChildren: () =>
          Promise.resolve([
            {
              path: '',
              component: options.variant === 'v1' ? PreviewV1 : PreviewV2,
            },
          ] satisfies Routes),
      })),
    ];

    const { fixture, container, router, controller } = await renderWith(routes);

    // Asked before anything has begun: it attaches to the transaction the guard is about to open.
    const observed = controller.outcome();
    await router.navigateByUrl('/preview');
    await flush(fixture);

    expect(await observed).toEqual({ outcome: 'committed' });
    expect(container.textContent).toContain('V2');
  });

  it('a beginSwitch caller reads a rollback through outcome(), same taxonomy as switch()', async () => {
    let switched = false;
    let blocked = false;

    const routes: Routes = [
      { path: 'home', component: PageHome },
      mountSwitchRoute('preview', () => ({
        path: 'preview',
        canMatch: [
          () => {
            if (switched) return true;
            switched = true;
            blocked = true;
            return TestBed.runInInjectionContext(() =>
              injectMountController('preview'),
            ).beginSwitch();
          },
        ],
        canActivate: [() => !blocked],
        loadChildren: () =>
          Promise.resolve([
            { path: '', component: PreviewV1 },
          ] satisfies Routes),
      })),
    ];

    const { fixture, router, controller } = await renderWith(routes);

    const observed = controller.outcome();
    expect(await router.navigateByUrl('/preview')).toBe(false);
    await flush(fixture);

    expect(await observed).toEqual({
      outcome: 'rolled-back',
      reason: 'cancelled',
    });
  });

  it('beginSwitch swaps inside recognition and rides the redirect hop to a commit', async () => {
    const options: MountOptions = { variant: 'v1' };
    let switched = false;

    const routes: Routes = [
      { path: 'home', component: PageHome },
      mountSwitchRoute('preview', () => ({
        path: 'preview',
        canMatch: [
          () => {
            if (switched) return true;
            switched = true;
            return TestBed.runInInjectionContext(() =>
              injectMountController('preview'),
            ).beginSwitch();
          },
        ],
        loadChildren: () =>
          Promise.resolve([
            {
              path: '',
              component: options.variant === 'v1' ? PreviewV1 : PreviewV2,
            },
          ] satisfies Routes),
      })),
    ];

    const { fixture, container, router } = await renderWith(routes);

    options.variant = 'v2';
    await router.navigateByUrl('/preview');
    await flush(fixture);

    expect(switched).toBe(true);
    expect(container.textContent).toContain('V2');
    expect(router.url).toBe('/preview');
  });
});
