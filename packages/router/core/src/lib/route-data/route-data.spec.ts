/* eslint-disable @angular-eslint/component-selector */
import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from '../transition-router-outlet';
import {
  createRouteData,
  injectRouteData,
  provideRouteData,
  routeDataKey,
} from './route-data';

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

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 6; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('route-data', () => {
  it('fires at resolve time (before the component) with params, and injectRouteData returns the same instance', async () => {
    const KEY = routeDataKey<FakeRef & { id: Signal<string> }>('user');
    const order: string[] = [];
    let factoryRef: unknown = null;
    let componentRef: unknown = null;

    @Component({ selector: 'user-cmp', template: `user` })
    class UserCmp {
      readonly data = injectRouteData(KEY);
      constructor() {
        order.push('component');
        componentRef = this.data;
      }
    }

    @Component({
      selector: 'rd-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'users/:id',
            component: UserCmp,
            providers: [provideRouteData(KEY)],
            resolve: {
              user: createRouteData(KEY, (ctx) => {
                order.push('resolver');
                const ref = makeRef('loading') as FakeRef & {
                  id: Signal<string>;
                };
                ref.id = computed(() => ctx.params()['id'] ?? '');
                registerResource(ref, { suspends: true });
                factoryRef = ref;
                return ref;
              }),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    await TestBed.inject(Router).navigateByUrl('/users/42');
    await flush(fixture);

    expect(order).toEqual(['resolver', 'component']); // fired before the component
    expect(componentRef).toBe(factoryRef); // same instance
    expect((factoryRef as { id: Signal<string> }).id()).toBe('42');
  });

  it("ctx.param('id') reads the live param; a typo'd name dev-errors once and yields ''", async () => {
    const KEY = routeDataKey<{ id: Signal<string>; typo: Signal<string> }>(
      'param-access',
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    @Component({ selector: 'p-cmp', template: `p` })
    class PCmp {
      readonly data = injectRouteData(KEY);
    }
    @Component({
      selector: 'p-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'users/:id',
            component: PCmp,
            providers: [provideRouteData(KEY)],
            resolve: {
              d: createRouteData(KEY, (ctx) => ({
                id: ctx.param('id'),
                typo: ctx.param('userId'), // not a param on this route
              })),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/users/42');
    await flush(fixture);

    const slotData = (fixture.debugElement.query(
      // the rendered component instance carries the injected data
      (n) => n.componentInstance instanceof PCmp,
    )?.componentInstance as PCmp | undefined)?.data;

    expect(slotData?.id()).toBe('42');
    expect(slotData?.typo()).toBe(''); // safe empty, not undefined
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("ctx.param('userId')"),
    );

    err.mockClear();
    await router.navigateByUrl('/users/7');
    await flush(fixture);
    expect(slotData?.id()).toBe('7'); // live across param navigation
    expect(err).not.toHaveBeenCalled(); // warned once, not per read
    err.mockRestore();
  });

  it('onError fires per TRANSITION into error, with the error, on the live path', async () => {
    const KEY = routeDataKey<FakeRef>('erroring');
    const seen: unknown[] = [];
    let ref!: FakeRef;

    @Component({ selector: 'e-cmp', template: `e` })
    class ECmp {
      readonly data = injectRouteData(KEY);
    }
    @Component({
      selector: 'e-host',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'e',
            component: ECmp,
            providers: [provideRouteData(KEY)],
            resolve: {
              d: createRouteData(
                KEY,
                () => (ref = makeRef('loading')),
                { onError: (error) => seen.push(error) },
              ),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    await TestBed.inject(Router).navigateByUrl('/e');
    await flush(fixture);
    expect(seen).toEqual([]); // loading — nothing yet

    (ref.error as WritableSignal<unknown>).set(new Error('boom'));
    ref.status.set('error');
    await flush(fixture);
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toBe('boom');

    ref.status.set('reloading'); // retry…
    await flush(fixture);
    ref.status.set('error'); // …fails again: a NEW transition fires again
    await flush(fixture);
    expect(seen.length).toBe(2);

    ref.status.set('resolved'); // recovery does not fire
    await flush(fixture);
    expect(seen.length).toBe(2);
  });

  it('memoizes: a resolver re-run on param change reuses the same instance, and live params update', async () => {
    const KEY = routeDataKey<FakeRef & { id: Signal<string> }>('user');
    const created: unknown[] = [];

    @Component({ selector: 'user-cmp', template: `id={{ data.id() }}` })
    class UserCmp {
      readonly data = injectRouteData(KEY);
    }
    @Component({
      selector: 'rd-host2',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'users/:id',
            component: UserCmp,
            providers: [provideRouteData(KEY)],
            resolve: {
              user: createRouteData(KEY, (ctx) => {
                const ref = makeRef('resolved') as FakeRef & {
                  id: Signal<string>;
                };
                ref.id = computed(() => ctx.params()['id'] ?? '');
                registerResource(ref, { suspends: false });
                created.push(ref);
                return ref;
              }),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/users/1');
    await flush(fixture);
    expect(container.textContent).toContain('id=1');

    await router.navigateByUrl('/users/2'); // param change
    await flush(fixture);

    expect(created.length).toBe(1); // not recreated — memoized
    expect(container.textContent).toContain('id=2'); // but params went live
  });

  it('params stay live even when the resolver does NOT re-run (query-param change, default runGuardsAndResolvers)', async () => {
    const KEY = routeDataKey<FakeRef & { tab: Signal<string> }>('q');
    let runs = 0;

    @Component({ selector: 'q-cmp', template: `tab={{ data.tab() }}` })
    class QCmp {
      readonly data = injectRouteData(KEY);
    }
    @Component({
      selector: 'rd-host3',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          {
            path: 'list',
            component: QCmp,
            providers: [provideRouteData(KEY)],
            resolve: {
              q: createRouteData(KEY, (ctx) => {
                runs++;
                const ref = makeRef('resolved') as FakeRef & {
                  tab: Signal<string>;
                };
                ref.tab = computed(() => ctx.queryParams()['tab'] ?? '');
                registerResource(ref, { suspends: false });
                return ref;
              }),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/list?tab=a');
    await flush(fixture);
    expect(container.textContent).toContain('tab=a');
    expect(runs).toBe(1);

    await router.navigateByUrl('/list?tab=b'); // query-only change — resolver does NOT re-run
    await flush(fixture);

    expect(runs).toBe(1); // confirmed: no re-run
    expect(container.textContent).toContain('tab=b'); // ...yet params went live anyway
  });

  it('the outlet holds the previous view until the route-data resource settles', async () => {
    const KEY = routeDataKey<FakeRef>('user');
    const ref = makeRef('loading');

    @Component({ selector: 'route-a', template: `route-A` })
    class RouteA {}
    @Component({ selector: 'route-b', template: `route-B` })
    class RouteB {
      readonly data = injectRouteData(KEY);
    }
    @Component({
      selector: 'rd-host4',
      imports: [TransitionRouterOutlet],
      template: `<mm-transition-outlet />`,
    })
    class Host {}

    const { fixture, container } = await render(Host, {
      providers: [
        provideRouter([
          { path: 'a', component: RouteA },
          {
            path: 'b',
            component: RouteB,
            providers: [provideRouteData(KEY)],
            resolve: {
              user: createRouteData(KEY, () => {
                registerResource(ref, { suspends: true });
                return ref;
              }),
            },
          },
        ]),
        provideLocationMocks(),
      ],
    });

    const router = TestBed.inject(Router);
    await router.navigateByUrl('/a');
    await flush(fixture);

    await router.navigateByUrl('/b'); // route-data resource is loading → A holds
    await flush(fixture);
    expect(container.querySelector('route-a')).not.toBeNull();

    ref.value.set({ ok: true });
    ref.status.set('resolved');
    await flush(fixture);

    expect(container.querySelector('route-a')).toBeNull();
    expect(container.textContent).toContain('route-B');
  });

  it('injectRouteData throws a helpful error when the route did not provide the data', () => {
    const KEY = routeDataKey<FakeRef>('missing');
    expect(() =>
      TestBed.runInInjectionContext(() => injectRouteData(KEY)),
    ).toThrowError(/No route data "missing"/);
  });
});
