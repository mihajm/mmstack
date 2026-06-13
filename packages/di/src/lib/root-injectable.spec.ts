import { InjectionToken, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { rootInjectable } from './root-injectable';

describe('root-injectable', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  describe('rootInjectable', () => {
    it('should create a lazy singleton injection function', () => {
      let factoryCalls = 0;

      const injectSingleton = rootInjectable(() => {
        factoryCalls++;
        return { instanceName: 'global-singleton' };
      });

      TestBed.runInInjectionContext(() => {
        // First access calls factory
        const result1 = injectSingleton();
        expect(result1.instanceName).toBe('global-singleton');
        expect(factoryCalls).toBe(1);

        // Second access returns the cached singleton reference
        const result2 = injectSingleton();
        expect(result2).toBe(result1);
        expect(factoryCalls).toBe(1);
      });
    });

    it('should create a fresh singleton per application (SSR isolation)', () => {
      let factoryCalls = 0;
      const injectThing = rootInjectable(() => ({ id: ++factoryCalls }));

      const first = TestBed.runInInjectionContext(() => injectThing());
      expect(first.id).toBe(1);

      // a fresh application = a fresh root injector — what each SSR request gets
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});

      const second = TestBed.runInInjectionContext(() => injectThing());
      expect(second).not.toBe(first);
      expect(second.id).toBe(2);
    });

    it('should pass the root injector to the factory', () => {
      const DEP = new InjectionToken<string>('dep');
      const injectThing = rootInjectable((injector) => injector.get(DEP));

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: DEP, useValue: 'dep-value' }],
      });

      TestBed.runInInjectionContext(() => {
        expect(injectThing()).toBe('dep-value');
      });
    });

    it('should accept an explicit injector outside an injection context', () => {
      const injectThing = rootInjectable(() => 'val');
      const injector = TestBed.inject(Injector);

      // no runInInjectionContext — explicit injector instead
      expect(injectThing({ injector })).toBe('val');
    });
  });
});
