/* eslint-disable @angular-eslint/component-selector */
/* eslint-disable @angular-eslint/directive-selector */

/**
 * Sanity probes for the Angular DI behaviors the route-level data work relies on. These
 * are deliberately framework-facing (real router, real outlet, real route env injectors):
 * if an Angular upgrade or a v21-lts backport changes any of these, a probe fails here
 * instead of the feature breaking in a subtle way.
 *
 * The three load-bearing facts:
 *  A. A provider on the OUTLET's element injector shadows a same-token provider in the
 *     ROUTE's environment injector for a routed component. (→ a per-route env scope is
 *     invisible to the component while the outlet provides an element scope — why the
 *     outlet must *forward* to the route scope rather than provide its own.)
 *  B. The route environment injector (and thus a per-route `provideTransitionScope()`) is
 *     reused across param-only navigations. (→ the route's scope persists; a resolver that
 *     re-runs on param change updates the same resource rather than leaking a new one.)
 *  C. A route resolver runs in the route's injector — it sees the route `providers` and the
 *     matched snapshot params, fires before the component constructs, and is non-blocking
 *     when it returns synchronously. (→ `provideRouteData` fires the resource here.)
 */

import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  Directive,
  inject,
  InjectionToken,
  provideEnvironmentInitializer,
  type Signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  provideRouter,
  Router,
  RouterOutlet,
} from '@angular/router';
import { render } from '@testing-library/angular';
import { filter } from 'rxjs';

const SCOPE = new InjectionToken<string>('probe-scope');

@Directive({ selector: '[probeElement]', providers: [{ provide: SCOPE, useValue: 'element' }] })
class ProbeElementDir {}

@Component({
  selector: 'di-host',
  imports: [RouterOutlet, ProbeElementDir],
  template: `<router-outlet probeElement></router-outlet>`,
})
class DiHost {}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 6; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('Angular DI assumptions for route-level data', () => {
  it('A: an element-injector provider shadows a route-env provider for a routed component', async () => {
    let resolvedInComponent: string | null = null;

    @Component({ selector: 'probe-a', template: `probe-A` })
    class ProbeA {
      constructor() {
        resolvedInComponent = inject(SCOPE, { optional: true });
      }
    }

    const { fixture } = await render(DiHost, {
      providers: [
        provideRouter([
          {
            path: 'x',
            component: ProbeA,
            providers: [{ provide: SCOPE, useValue: 'env' }],
          },
        ]),
        provideLocationMocks(),
      ],
    });

    await TestBed.inject(Router).navigateByUrl('/x');
    await flush(fixture);

    // element injector wins → the route-env 'env' is shadowed by the outlet element 'element'
    expect(resolvedInComponent).toBe('element');
  });

  it('B: the route env injector is reused across param-only navigations', async () => {
    let initRuns = 0;

    @Component({ selector: 'probe-b', template: `probe-B` })
    class ProbeB {}

    const { fixture } = await render(DiHost, {
      providers: [
        provideRouter([
          {
            path: 'z/:id',
            component: ProbeB,
            providers: [
              provideEnvironmentInitializer(() => {
                initRuns++;
              }),
            ],
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/z/1');
    await flush(fixture);
    await router.navigateByUrl('/z/2');
    await flush(fixture);

    expect(initRuns).toBe(1); // same env injector → its initializer (and scope) persist
  });

  it('C: a route resolver sees the route providers + snapshot params, and runs before the component', async () => {
    const seen: { scope: string | null; paramId: string | null } = {
      scope: 'unset',
      paramId: null,
    };
    const order: string[] = [];

    @Component({ selector: 'probe-c', template: `probe-C` })
    class ProbeC {
      constructor() {
        order.push('component');
      }
    }

    const { fixture } = await render(DiHost, {
      providers: [
        provideRouter([
          {
            path: 'v/:id',
            component: ProbeC,
            providers: [{ provide: SCOPE, useValue: 'env' }],
            resolve: {
              _: (route: ActivatedRouteSnapshot) => {
                order.push('resolver');
                seen.scope = inject(SCOPE, { optional: true });
                seen.paramId = route.paramMap.get('id');
                return null;
              },
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    await TestBed.inject(Router).navigateByUrl('/v/55');
    await flush(fixture);

    expect(seen.scope).toBe('env'); // resolver injection context includes route providers
    expect(seen.paramId).toBe('55'); // snapshot params are real at resolve time
    expect(order).toEqual(['resolver', 'component']); // resolve runs before construction
  });

  it('D: params derived from router state by routeConfig stay live across param navs (no resolver re-run dependency)', async () => {
    // `inject(ActivatedRoute)` in a resolver yields the PARENT, not the matched route, so it
    // is not a usable live params source. Instead derive params from the live router state,
    // keyed by the snapshot's routeConfig, recomputed on NavigationEnd — built ONCE so it
    // proves the source stays reactive even if the resolver never re-runs. This is exactly
    // what `createRouteData` ships.
    const holder: { sig: Signal<string | null> | null } = { sig: null };

    @Component({ selector: 'probe-d', template: `probe-D` })
    class ProbeD {}

    const { fixture } = await render(DiHost, {
      providers: [
        provideRouter([
          {
            path: 'v/:id',
            component: ProbeD,
            resolve: {
              _: (route: ActivatedRouteSnapshot) => {
                if (!holder.sig) {
                  const router = inject(Router);
                  const tick = toSignal(
                    router.events.pipe(filter((e) => e instanceof NavigationEnd)),
                    { initialValue: null },
                  );
                  const findId = () => {
                    const stack = [router.routerState.snapshot.root];
                    while (stack.length) {
                      const n = stack.shift();
                      if (!n) continue;
                      if (n.routeConfig === route.routeConfig)
                        return n.paramMap.get('id');
                      stack.push(...n.children);
                    }
                    return route.paramMap.get('id'); // fallback: resolve-time snapshot
                  };
                  holder.sig = computed(() => {
                    tick();
                    return findId();
                  });
                }
                return null;
              },
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/v/55');
    await flush(fixture);
    expect(holder.sig?.()).toBe('55');

    await router.navigateByUrl('/v/66');
    await flush(fixture);
    expect(holder.sig?.()).toBe('66'); // same signal, updated — no new resolver run needed
  });
});
