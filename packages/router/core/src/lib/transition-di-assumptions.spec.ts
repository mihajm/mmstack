/* eslint-disable @angular-eslint/component-selector */
/* eslint-disable @angular-eslint/directive-selector */

// Probes for Angular DI behaviors the route-level data work relies on; a probe fails here
// if an Angular upgrade or v21-lts backport changes them.
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

    expect(initRuns).toBe(1);
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

    expect(seen.scope).toBe('env');
    expect(seen.paramId).toBe('55');
    expect(order).toEqual(['resolver', 'component']);
  });

  it('D: params derived from router state by routeConfig stay live across param navs (no resolver re-run dependency)', async () => {
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
                    return route.paramMap.get('id');
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
    expect(holder.sig?.()).toBe('66');
  });
});
