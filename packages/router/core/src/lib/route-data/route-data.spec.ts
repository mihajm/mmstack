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
