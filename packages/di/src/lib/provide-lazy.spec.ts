import {
  Injectable,
  Injector,
  runInInjectionContext,
  type OnDestroy,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideLazy } from './provide-lazy';

describe('provideLazy', () => {
  it('throws when injected but never provided; resolves null when optional', async () => {
    const [injectThing] = provideLazy<{ x: number }>('Thing');

    expect(() =>
      TestBed.runInInjectionContext(() => injectThing()),
    ).toThrow(/never provided/i);

    const getOptional = TestBed.runInInjectionContext(() =>
      injectThing({ optional: true }),
    );
    expect(await getOptional()).toBeNull();
  });

  it('resolves a loader provided in a parent providers array', async () => {
    @Injectable()
    class Service {
      value() {
        return 42;
      }
    }

    const [injectService, provideService] = provideLazy<Service>('Service');

    TestBed.configureTestingModule({
      providers: [provideService(() => Promise.resolve(Service))],
    });

    const get = TestBed.runInInjectionContext(() => injectService());
    const instance = await get();

    expect(instance).toBeInstanceOf(Service);
    expect(instance.value()).toBe(42);
  });

  it('shares one instance across consumers under the same boundary', async () => {
    @Injectable()
    class Shared {}

    const [injectShared, provideShared] = provideLazy<Shared>('Shared');

    TestBed.configureTestingModule({
      providers: [provideShared(() => Promise.resolve(Shared))],
    });

    const [a, b] = TestBed.runInInjectionContext(() => [
      injectShared(),
      injectShared(),
    ]);

    expect(await a()).toBe(await b());
  });

  it('gives separate boundaries separate instances', async () => {
    @Injectable()
    class Scoped {}

    const [injectScoped, provideScoped] = provideLazy<Scoped>('Scoped');
    const loader = () => Promise.resolve(Scoped);
    const parent = TestBed.inject(Injector);

    const i1 = Injector.create({ providers: [...provideScoped(loader)], parent });
    const i2 = Injector.create({ providers: [...provideScoped(loader)], parent });

    const g1 = runInInjectionContext(i1, () => injectScoped());
    const g2 = runInInjectionContext(i2, () => injectScoped());

    expect(await g1()).not.toBe(await g2());
  });

  it('tears down the instance when the providing scope is destroyed', async () => {
    let destroyed = 0;

    @Injectable()
    class Scoped implements OnDestroy {
      ngOnDestroy() {
        destroyed++;
      }
    }

    const [injectScoped, provideScoped] = provideLazy<Scoped>('Scoped');

    const scope = Injector.create({
      providers: [...provideScoped(() => Promise.resolve(Scoped))],
      parent: TestBed.inject(Injector),
    }) as Injector & { destroy(): void };

    const get = runInInjectionContext(scope, () => injectScoped());
    await get();
    expect(destroyed).toBe(0);

    scope.destroy();
    expect(destroyed).toBe(1);
  });

  it('supports swapping the loader via TestBed.overrideProvider', async () => {
    interface Named {
      name(): string;
    }

    @Injectable()
    class Real implements Named {
      name() {
        return 'real';
      }
    }

    @Injectable()
    class Mock implements Named {
      name() {
        return 'mock';
      }
    }

    const [injectThing, provideThing, loaderToken] = provideLazy<Named>('Thing');

    TestBed.configureTestingModule({
      providers: [provideThing(() => Promise.resolve(Real))],
    });
    TestBed.overrideProvider(loaderToken, {
      useValue: () => Promise.resolve(Mock),
    });

    const get = TestBed.runInInjectionContext(() => injectThing());
    expect((await get()).name()).toBe('mock');
  });
});
