import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  DestroyRef,
  EnvironmentInjector,
  inject,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  getTransitionScope,
  provideTransitionScope,
  registerResource,
} from '@mmstack/primitives';
import { PreloadRequester } from '../preloading/preload-requester';
import {
  createRouteData,
  provideRouteData,
  type RouteDataContext,
  routeDataKey,
} from './route-data';
import {
  RouteDataPrefetcher,
  withRouteData,
  type RouteDataOptions,
} from './with-route-data';

@Component({ selector: 'blank-cmp', template: `` })
class Blank {}

type Ref = ResourceRef<unknown> & { status: WritableSignal<ResourceStatus> };
const ref = (status: ResourceStatus): Ref => {
  const s = signal<ResourceStatus>(status);
  return {
    status: s,
    value: signal(undefined),
    isLoading: computed(() => s() === 'loading'),
    hasValue: () => false,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as Ref;
};

function setup(
  factory: (ctx: RouteDataContext) => unknown,
  options?: RouteDataOptions,
  extra: unknown[] = [],
) {
  const KEY = routeDataKey<unknown>('warm');
  let attempts = 0;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'users/:id',
          component: Blank,
          providers: [provideRouteData(KEY)],
          resolve: {
            d: createRouteData(KEY, (ctx) => {
              attempts++;
              return factory(ctx);
            }),
          },
        },
      ]),
      provideLocationMocks(),
      withRouteData(options),
      ...(extra as never[]),
    ],
  });
  TestBed.inject(RouteDataPrefetcher).connect();
  const req = TestBed.inject(PreloadRequester);
  return { req, attempts: () => attempts };
}

const micro = () => Promise.resolve();

describe('withRouteData contract: scope and timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('a code-only preload warms no data', async () => {
    const s = setup(() => ({}));
    s.req.startPreload('/users/42', 'code');
    await micro();
    expect(s.attempts()).toBe(0);
  });

  it('the default timeout is 30 seconds', () => {
    vi.useFakeTimers();
    const s = setup(() => ref('loading'));
    s.req.startPreload('/users/42');
    vi.advanceTimersByTime(1000);
    s.req.startPreload('/users/42');
    expect(s.attempts()).toBe(1);
    vi.advanceTimersByTime(29_000);
    s.req.startPreload('/users/42');
    expect(s.attempts()).toBe(2);
  });

  it('a configured timeout lets a stuck warm retry after it', () => {
    vi.useFakeTimers();
    const s = setup(() => ref('loading'), { timeout: 50 });
    s.req.startPreload('/users/42');
    vi.advanceTimersByTime(49);
    s.req.startPreload('/users/42');
    expect(s.attempts()).toBe(1);
    vi.advanceTimersByTime(1);
    s.req.startPreload('/users/42');
    expect(s.attempts()).toBe(2);
  });
});

describe('withRouteData contract: the throwaway injector is always torn down', () => {
  afterEach(() => vi.useRealTimers());

  const destroyedAfter = (body: () => unknown) => {
    const destroyed = vi.fn();
    const factory = () => {
      inject(DestroyRef).onDestroy(destroyed);
      return body();
    };
    return { destroyed, factory };
  };

  it('after a plain return', async () => {
    const t = destroyedAfter(() => ({ plain: true }));
    const s = setup(t.factory);
    s.req.startPreload('/users/1');
    await micro();
    expect(t.destroyed).toHaveBeenCalledTimes(1);
  });

  it('after the resource settles', async () => {
    const r = ref('loading');
    const t = destroyedAfter(() => r);
    const s = setup(t.factory);
    s.req.startPreload('/users/1');
    r.status.set('resolved');
    TestBed.tick();
    await micro();
    expect(t.destroyed).toHaveBeenCalledTimes(1);
  });

  it('after the timeout', () => {
    vi.useFakeTimers();
    const t = destroyedAfter(() => ref('loading'));
    const s = setup(t.factory, { timeout: 50 });
    s.req.startPreload('/users/1');
    vi.advanceTimersByTime(50);
    expect(t.destroyed).toHaveBeenCalledTimes(1);
  });

  it('after the factory throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = destroyedAfter(() => {
      throw new Error('boom');
    });
    const s = setup(t.factory);
    s.req.startPreload('/users/1');
    expect(t.destroyed).toHaveBeenCalledTimes(1);
  });
});

describe('withRouteData contract: isolation', () => {
  it('a prefetched resource does not hold the app root transition scope', () => {
    const s = setup(
      () => {
        const r = ref('loading');
        registerResource(r, { suspends: true });
        return r;
      },
      undefined,
      [provideTransitionScope()],
    );
    s.req.startPreload('/users/1');
    TestBed.tick();
    const root = getTransitionScope(TestBed.inject(EnvironmentInjector));
    expect(root).not.toBeNull();
    expect(root?.pending()).toBe(false);
  });
});
