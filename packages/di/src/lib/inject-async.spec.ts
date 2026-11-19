import {
  Component,
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  type OnDestroy,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectAsync, onIdle } from './inject-async';

describe('injectAsync', () => {
  it('defers the loader until the getter is called, then memoizes', async () => {
    let instances = 0;
    let loads = 0;

    @Injectable()
    class HeavyService {
      constructor() {
        instances++;
      }
      work() {
        return 'done';
      }
    }

    TestBed.configureTestingModule({ providers: [HeavyService] });

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => {
        loads++;
        return Promise.resolve(HeavyService);
      }),
    );

    expect(loads).toBe(0);
    expect(instances).toBe(0);

    const first = await get();
    expect(loads).toBe(1);
    expect(instances).toBe(1);
    expect(first).toBeInstanceOf(HeavyService);
    expect(first.work()).toBe('done');

    const second = await get();
    expect(loads).toBe(1); // loader not called again
    expect(second).toBe(first); // same instance
  });

  it('resolves a providedIn:root service as the shared singleton (native parity)', async () => {
    @Injectable({ providedIn: 'root' })
    class RootService {}

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(RootService)),
    );

    expect(await get()).toBe(TestBed.inject(RootService));
  });

  it('auto-provides a plain @Injectable() with no providedIn (lifted requirement)', async () => {
    @Injectable()
    class BareService {
      readonly tag = 'bare';
    }

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(BareService)),
    );

    const instance = await get();
    expect(instance).toBeInstanceOf(BareService);
    expect(instance.tag).toBe('bare');
  });

  it('gives distinct call sites distinct auto-provided instances', async () => {
    @Injectable()
    class BareService {}

    const [a, b] = TestBed.runInInjectionContext(() => [
      injectAsync(() => Promise.resolve(BareService)),
      injectAsync(() => Promise.resolve(BareService)),
    ]);

    expect(await a()).not.toBe(await b());
  });

  it('unwraps a default export', async () => {
    @Injectable({ providedIn: 'root' })
    class DefaultExported {}

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve({ default: DefaultExported })),
    );

    expect(await get()).toBeInstanceOf(DefaultExported);
  });

  it('throws for an unprovided InjectionToken, resolves null when optional', async () => {
    const TOKEN = new InjectionToken<string>('LazyToken');

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(TOKEN)),
    );
    await expect(get()).rejects.toThrow(/no provider/i);

    const getOptional = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(TOKEN), { optional: true }),
    );
    expect(await getOptional()).toBeNull();
  });

  it('prefetch triggers loading before the getter is called', async () => {
    @Injectable({ providedIn: 'root' })
    class Prefetched {}

    let loads = 0;
    let resolvePrefetch!: () => void;
    const prefetch = () => new Promise<void>((r) => (resolvePrefetch = r));

    TestBed.runInInjectionContext(() =>
      injectAsync(
        () => {
          loads++;
          return Promise.resolve(Prefetched);
        },
        { prefetch },
      ),
    );

    expect(loads).toBe(0);
    resolvePrefetch();
    await new Promise((r) => setTimeout(r));
    expect(loads).toBe(1);
  });

  it('does not prefetch on the server', async () => {
    @Injectable({ providedIn: 'root' })
    class Prefetched {}

    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });

    let loads = 0;
    let resolvePrefetch: (() => void) | undefined;
    const prefetch = () => new Promise<void>((r) => (resolvePrefetch = r));

    TestBed.runInInjectionContext(() =>
      injectAsync(
        () => {
          loads++;
          return Promise.resolve(Prefetched);
        },
        { prefetch },
      ),
    );

    await new Promise((r) => setTimeout(r));
    expect(resolvePrefetch).toBeUndefined(); // trigger never even invoked
    expect(loads).toBe(0);
  });

  it('destroys an auto-provided instance when the host is destroyed', async () => {
    let destroyed = 0;

    @Injectable()
    class ScopedService implements OnDestroy {
      ngOnDestroy() {
        destroyed++;
      }
    }

    @Component({ template: '' })
    class HostComponent {
      readonly get = injectAsync(() => Promise.resolve(ScopedService));
    }

    const fixture = TestBed.createComponent(HostComponent);
    const instance = await fixture.componentInstance.get();
    expect(instance).toBeInstanceOf(ScopedService);

    fixture.destroy();
    expect(destroyed).toBe(1);
  });

  it('does NOT destroy a root/provided instance when a consumer is destroyed', async () => {
    let destroyed = 0;

    @Injectable({ providedIn: 'root' })
    class RootService implements OnDestroy {
      ngOnDestroy() {
        destroyed++;
      }
    }

    @Component({ template: '' })
    class HostComponent {
      readonly get = injectAsync(() => Promise.resolve(RootService));
    }

    const fixture = TestBed.createComponent(HostComponent);
    await fixture.componentInstance.get();

    fixture.destroy();
    expect(destroyed).toBe(0); // root singleton lives on
  });

  it('rejects in dev (and never constructs) when the host dies mid-import', async () => {
    let instances = 0;

    @Injectable()
    class LateService {
      constructor() {
        instances++;
      }
    }

    let resolveLoad!: (token: typeof LateService) => void;

    @Component({ template: '' })
    class HostComponent {
      readonly get = injectAsync(
        () => new Promise<typeof LateService>((r) => (resolveLoad = r)),
      );
    }

    const fixture = TestBed.createComponent(HostComponent);
    const pending = fixture.componentInstance.get(); // start the load (pending)

    fixture.destroy(); // host gone before the import resolves
    resolveLoad(LateService);

    await expect(pending).rejects.toThrow(/destroyed/i);
    expect(instances).toBe(0); // never constructed into a dead injector (no leak)
  });

  it('resolves against an injector passed via providedWith (Injector form)', async () => {
    @Injectable()
    class BareService {}

    const target = Injector.create({
      providers: [],
      parent: TestBed.inject(Injector),
    });

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(BareService), { providedWith: target }),
    );

    expect(await get()).toBeInstanceOf(BareService);
  });

  describe('providedWith lifetime (Injector form)', () => {
    const setup = () => {
      const counter = { destroyed: 0 };

      @Injectable()
      class ScopedService implements OnDestroy {
        ngOnDestroy() {
          counter.destroyed++;
        }
      }

      const root = TestBed.inject(EnvironmentInjector);
      const callSite = createEnvironmentInjector([], root);
      const target = createEnvironmentInjector([], root);

      const get = runInInjectionContext(callSite, () =>
        injectAsync(() => Promise.resolve(ScopedService), {
          providedWith: target,
        }),
      );

      return { counter, callSite, target, get };
    };

    it('destroys the auto-provided instance with the target injector', async () => {
      const { counter, callSite, target, get } = setup();
      await get();

      target.destroy();
      expect(counter.destroyed).toBe(1);

      callSite.destroy();
      expect(counter.destroyed).toBe(1);
    });

    it('keeps the auto-provided instance alive when only the call site is destroyed', async () => {
      const { counter, callSite, target, get } = setup();
      const instance = await get();

      callSite.destroy();
      expect(counter.destroyed).toBe(0);
      expect(await get()).toBe(instance);

      target.destroy();
      expect(counter.destroyed).toBe(1);
    });
  });

  it('resolves against an injector passed via providedWith (InjectionToken form)', async () => {
    @Injectable()
    class BareService {}

    const TARGET = new InjectionToken<Injector>('Target');
    TestBed.configureTestingModule({
      providers: [{ provide: TARGET, useFactory: () => inject(Injector) }],
    });

    const get = TestBed.runInInjectionContext(() =>
      injectAsync(() => Promise.resolve(BareService), { providedWith: TARGET }),
    );

    expect(await get()).toBeInstanceOf(BareService);
  });

  it('skips prefetch on a slow / data-saver connection', async () => {
    @Injectable({ providedIn: 'root' })
    class Prefetched {}

    const nav = globalThis.navigator as { connection?: unknown };
    const original = nav.connection;
    Object.defineProperty(nav, 'connection', {
      value: { saveData: true },
      configurable: true,
    });

    try {
      let loads = 0;
      let resolvePrefetch: (() => void) | undefined;
      const prefetch = () => new Promise<void>((r) => (resolvePrefetch = r));

      TestBed.runInInjectionContext(() =>
        injectAsync(
          () => {
            loads++;
            return Promise.resolve(Prefetched);
          },
          { prefetch },
        ),
      );

      await new Promise((r) => setTimeout(r));
      expect(resolvePrefetch).toBeUndefined(); // trigger never invoked
      expect(loads).toBe(0);
    } finally {
      Object.defineProperty(nav, 'connection', {
        value: original,
        configurable: true,
      });
    }
  });

  describe('prefetch shorthands', () => {
    it("'idle' triggers loading without the getter being called", async () => {
      @Injectable({ providedIn: 'root' })
      class Prefetched {}

      let loads = 0;
      TestBed.runInInjectionContext(() =>
        injectAsync(
          () => {
            loads++;
            return Promise.resolve(Prefetched);
          },
          { prefetch: 'idle' },
        ),
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(loads).toBe(1);
    });

    it('a numeric deadline triggers loading', async () => {
      @Injectable({ providedIn: 'root' })
      class Prefetched {}

      let loads = 0;
      TestBed.runInInjectionContext(() =>
        injectAsync(
          () => {
            loads++;
            return Promise.resolve(Prefetched);
          },
          { prefetch: 1 },
        ),
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(loads).toBe(1);
    });
  });

  describe('prefetch with requestIdleCallback', () => {
    let idleCallbacks: Array<() => void> = [];

    // a busy browser: idle never comes on its own, only a deadline fires the callback
    const stubBusyBrowser = () => {
      idleCallbacks = [];
      vi.stubGlobal(
        'requestIdleCallback',
        (cb: () => void, opts?: { timeout?: number }) => {
          idleCallbacks.push(cb);
          if (opts?.timeout !== undefined) setTimeout(cb, opts.timeout);
          return idleCallbacks.length;
        },
      );
    };

    const goIdle = () => idleCallbacks.splice(0).forEach((cb) => cb());

    afterEach(() => vi.unstubAllGlobals());

    const countLoads = (prefetch: 'idle' | number) => {
      @Injectable({ providedIn: 'root' })
      class Prefetched {}

      const counter = { loads: 0 };
      TestBed.runInInjectionContext(() =>
        injectAsync(
          () => {
            counter.loads++;
            return Promise.resolve(Prefetched);
          },
          { prefetch },
        ),
      );
      return counter;
    };

    it("'idle' waits for the browser to go idle, then loads", async () => {
      stubBusyBrowser();
      const counter = countLoads('idle');

      await new Promise((r) => setTimeout(r, 20));
      expect(counter.loads).toBe(0);

      goIdle();
      await new Promise((r) => setTimeout(r));
      expect(counter.loads).toBe(1);
    });

    it('a numeric deadline loads by the deadline even if the browser never goes idle', async () => {
      stubBusyBrowser();
      const counter = countLoads(30);

      await new Promise((r) => setTimeout(r, 60));
      expect(counter.loads).toBe(1);
    });

    it('a numeric deadline loads early when the browser goes idle first', async () => {
      stubBusyBrowser();
      const counter = countLoads(10_000);

      goIdle();
      await new Promise((r) => setTimeout(r));
      expect(counter.loads).toBe(1);
    });
  });

  describe('prefetch and the network connection', () => {
    const withConnection = async (
      connection: unknown,
      run: () => Promise<void>,
    ) => {
      const nav = globalThis.navigator as { connection?: unknown };
      const original = nav.connection;
      Object.defineProperty(nav, 'connection', {
        value: connection,
        configurable: true,
      });
      try {
        await run();
      } finally {
        Object.defineProperty(nav, 'connection', {
          value: original,
          configurable: true,
        });
      }
    };

    it.each([
      [{ effectiveType: '4g', saveData: false }, 1],
      [{ effectiveType: '4g' }, 1],
      [{ effectiveType: '3g', saveData: false }, 1],
      [{ effectiveType: '2g' }, 0],
      [{ effectiveType: 'slow-2g' }, 0],
      [{ effectiveType: '4g', saveData: true }, 0],
    ])('connection %o prefetches %i time(s)', (connection, expected) =>
      withConnection(connection, async () => {
        @Injectable({ providedIn: 'root' })
        class Prefetched {}

        let loads = 0;
        TestBed.runInInjectionContext(() =>
          injectAsync(
            () => {
              loads++;
              return Promise.resolve(Prefetched);
            },
            { prefetch: () => Promise.resolve() },
          ),
        );

        await new Promise((r) => setTimeout(r));
        expect(loads).toBe(expected);
      }),
    );
  });

  describe('prefetch failures', () => {
    type Listener = (reason: unknown) => void;
    const nodeProcess = (
      globalThis as unknown as {
        process: {
          on(event: 'unhandledRejection', fn: Listener): void;
          off(event: 'unhandledRejection', fn: Listener): void;
        };
      }
    ).process;

    const captureUnhandled = () => {
      const seen: unknown[] = [];
      const onUnhandled: Listener = (reason) => seen.push(reason);
      nodeProcess.on('unhandledRejection', onUnhandled);
      return {
        seen,
        stop: () => nodeProcess.off('unhandledRejection', onUnhandled),
      };
    };

    const settle = () => new Promise((r) => setTimeout(r, 10));

    it('a failed prefetch leaves no unhandled rejection, an explicit call still rejects', async () => {
      const unhandled = captureUnhandled();
      try {
        const get = TestBed.runInInjectionContext(() =>
          injectAsync(() => Promise.reject(new Error('chunk failed')), {
            prefetch: () => Promise.resolve(),
          }),
        );

        await settle();
        expect(unhandled.seen).toEqual([]);
        await expect(get()).rejects.toThrow('chunk failed');
      } finally {
        unhandled.stop();
      }
    });

    it('a prefetch of an unprovided InjectionToken leaves no unhandled rejection', async () => {
      const TOKEN = new InjectionToken<string>('Unprovided');
      const unhandled = captureUnhandled();
      try {
        const get = TestBed.runInInjectionContext(() =>
          injectAsync(() => Promise.resolve(TOKEN), {
            prefetch: () => Promise.resolve(),
          }),
        );

        await settle();
        expect(unhandled.seen).toEqual([]);
        await expect(get()).rejects.toThrow(/no provider/i);
      } finally {
        unhandled.stop();
      }
    });

    it('a prefetch that lands after the host is destroyed leaves no unhandled rejection', async () => {
      @Injectable()
      class LateService {}

      let resolveLoad!: (token: typeof LateService) => void;

      @Component({ template: '' })
      class HostComponent {
        readonly get = injectAsync(
          () => new Promise<typeof LateService>((r) => (resolveLoad = r)),
          { prefetch: () => Promise.resolve() },
        );
      }

      const unhandled = captureUnhandled();
      try {
        const fixture = TestBed.createComponent(HostComponent);
        const get = fixture.componentInstance.get;
        await settle();

        fixture.destroy();
        resolveLoad(LateService);

        await settle();
        expect(unhandled.seen).toEqual([]);
        await expect(get()).rejects.toThrow(/destroyed/i);
      } finally {
        unhandled.stop();
      }
    });
  });

  describe('onIdle', () => {
    it('resolves (browser idle / setTimeout fallback)', async () => {
      await expect(onIdle()).resolves.toBeUndefined();
      await expect(onIdle({ timeout: 1 })).resolves.toBeUndefined();
    });
  });
});
