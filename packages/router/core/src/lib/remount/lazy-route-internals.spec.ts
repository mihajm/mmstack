/* eslint-disable @angular-eslint/component-selector, @typescript-eslint/no-non-null-assertion */
// Private-slot pin. Every assertion here runs against a config the REAL Router built by
// really loading a real `loadChildren`, so a rename or reshape of Angular's private slots fails
// this file rather than silently degrading remount/mount-switch into no-ops.
import { provideLocationMocks } from '@angular/common/testing';
import { Component, Injectable, NgModule } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  type Route,
  Router,
  RouterModule,
} from '@angular/router';
import {
  destroyLazyInjectors,
  findMarkedRoute,
  hasLazyState,
  LAZY_STATE_SLOTS,
  loadedChildren,
  loadedInjector,
  ownedLazySlots,
  replaceRouteAt,
  retiredLazySlots,
  withoutLazyState,
} from './lazy-route-internals';

@Component({ selector: 'lazy-child', template: `lazy-child` })
class LazyChild {}

@Component({ selector: 'eager-page', template: `eager` })
class EagerPage {}

@Injectable()
class ScopedService {}

@NgModule({
  imports: [RouterModule.forChild([{ path: '', component: LazyChild }])],
})
class LazyFeatureModule {}

const MARKER = Symbol('spec-marker');

function lazyRoutes(): Route[] {
  return [
    { path: 'eager', component: EagerPage },
    {
      path: 'feature',
      data: { [MARKER]: 'feature' },
      loadChildren: () =>
        Promise.resolve([
          { path: '', component: LazyChild },
          { path: 'deep', component: LazyChild, data: { [MARKER]: 'deep' } },
        ] satisfies Route[]),
    },
    {
      path: 'scoped',
      loadChildren: () =>
        Promise.resolve([
          { path: '', component: LazyChild, providers: [ScopedService] },
        ] satisfies Route[]),
    },
    { path: 'mod', loadChildren: () => Promise.resolve(LazyFeatureModule) },
  ];
}

async function setup() {
  TestBed.configureTestingModule({
    providers: [provideRouter(lazyRoutes()), provideLocationMocks()],
  });
  const router = TestBed.inject(Router);
  return { router };
}

const featureRoute = (router: Router) =>
  router.config.find((r) => r.path === 'feature') as Route;

describe('lazy-route-internals (private-slot pin)', () => {
  it('the router really populates the slots this package reads', async () => {
    const { router } = await setup();
    const route = featureRoute(router);

    expect(hasLazyState(route)).toBe(false);
    expect(ownedLazySlots(route)).toEqual([]);

    await router.navigateByUrl('/feature');

    expect(hasLazyState(route)).toBe(true);
    expect(ownedLazySlots(route)).toContain('_loadedRoutes');
    expect(loadedChildren(route)?.map((r) => r.path)).toEqual(['', 'deep']);
  });

  it('pins the slot names — a rename in Angular fails here', async () => {
    const { router } = await setup();
    await router.navigateByUrl('/feature');
    const route = featureRoute(router);

    expect(LAZY_STATE_SLOTS).toEqual([
      '_loadedRoutes',
      '_loadedInjector',
      '_loadedNgModuleFactory',
      '_loadedComponent',
    ]);
    // The slots the router actually owns must be a subset of the ones we track: a NEW cache slot
    // Angular starts writing is one `withoutLazyState` would fail to drop.
    const tracked = new Set<string>(LAZY_STATE_SLOTS);
    const untracked = Object.keys(route).filter(
      (k) => k.startsWith('_') && !tracked.has(k) && k !== '_injector',
    );
    expect(untracked).toEqual([]);
  });

  it('finds no retired slot — `_loader$` returning means in-flight loads are route-reachable again', async () => {
    const { router } = await setup();
    const pending = router.navigateByUrl('/feature');
    expect(retiredLazySlots(featureRoute(router))).toEqual([]);
    await pending;
    expect(retiredLazySlots(featureRoute(router))).toEqual([]);
  });

  it('withoutLazyState drops every cache slot but keeps the route declaration and `_injector`', async () => {
    const { router } = await setup();
    await router.navigateByUrl('/feature');
    const route = featureRoute(router);
    (route as Record<string, unknown>)['_injector'] = 'kept';

    const fresh = withoutLazyState(route);

    expect(ownedLazySlots(fresh)).toEqual([]);
    expect(hasLazyState(fresh)).toBe(false);
    expect(fresh.path).toBe('feature');
    expect(fresh.loadChildren).toBe(route.loadChildren);
    expect(fresh.data).toBe(route.data);
    expect((fresh as Record<string, unknown>)['_injector']).toBe('kept');
    expect(hasLazyState(route)).toBe(true);
  });

  it('the router really populates the injector slots disposal reaches', async () => {
    const { router } = await setup();

    await router.navigateByUrl('/mod');
    const moduleRoute = router.config.find((r) => r.path === 'mod') as Route;
    expect(ownedLazySlots(moduleRoute)).toContain('_loadedInjector');
    expect(loadedInjector(moduleRoute)).toBeDefined();

    await router.navigateByUrl('/scoped');
    const scopedChild = loadedChildren(
      router.config.find((r) => r.path === 'scoped') as Route,
    )?.[0] as Record<string, unknown>;
    // A `providers` injector belongs to the loaded child, not to the lazy route itself.
    expect(scopedChild['_injector']).toBeDefined();
  });

  it('destroyLazyInjectors tears down the loaded subtree, not the route`s own providers', async () => {
    const { router } = await setup();
    await router.navigateByUrl('/mod');
    const moduleRoute = router.config.find((r) => r.path === 'mod') as Route;
    const moduleInjector = loadedInjector(moduleRoute);
    (moduleRoute as Record<string, unknown>)['_injector'] = 'kept';

    destroyLazyInjectors(moduleRoute);

    expect(moduleInjector?.destroyed).toBe(true);
    expect(loadedInjector(moduleRoute)).toBeUndefined();
    expect((moduleRoute as Record<string, unknown>)['_injector']).toBe('kept');
    // Idempotent: a second pass must not throw on an injector that is already gone.
    expect(() => destroyLazyInjectors(moduleRoute)).not.toThrow();
  });

  it('findMarkedRoute walks eager children AND lazily-loaded subtrees', async () => {
    const { router } = await setup();

    expect(findMarkedRoute(router.config, MARKER, 'deep')).toBeNull();

    await router.navigateByUrl('/feature');

    const found = findMarkedRoute(router.config, MARKER, 'deep');
    expect(found?.route.path).toBe('deep');
    expect(found?.container).toBe(loadedChildren(featureRoute(router)));
    expect(findMarkedRoute(router.config, MARKER, 'nope')).toBeNull();
  });

  it('replaceRouteAt swaps the route inside the container the router holds', async () => {
    const { router } = await setup();
    await router.navigateByUrl('/feature');

    const location = findMarkedRoute(router.config, MARKER, 'feature');
    expect(location).not.toBeNull();
    const fresh = withoutLazyState(location!.route);
    replaceRouteAt(location!, fresh);

    expect(featureRoute(router)).toBe(fresh);
    expect(hasLazyState(featureRoute(router))).toBe(false);
  });
});
