import { type Injector, InjectionToken } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RootInjectables, rootInjectable } from './root-injectable';

describe('root-injectable', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  describe('RootInjectables', () => {
    it('should register and return values', () => {
      const rootInjectables = TestBed.inject(RootInjectables);

      let callCount = 0;
      const key = rootInjectables.register(() => {
        callCount++;
        return { value: 'test' };
      });

      expect(rootInjectables.get(key)).toEqual({ value: 'test' });

      const key2 = rootInjectables.register(() => {
        callCount++;
        return { value: 'test2' };
      });

      expect(key).not.toBe(key2);
      expect(rootInjectables.get(key2)).toEqual({ value: 'test2' });
      expect(callCount).toBe(2);
    });

    it('should run register factory in the injection context', () => {
      const rootInjectables = TestBed.inject(RootInjectables);

      const testToken = new InjectionToken<string>('testToken', {
        providedIn: 'root',
        factory: () => 'injected-value',
      });

      const key = rootInjectables.register((injector) => {
        // Can use the passed injector
        const valFromInjector = injector.get(testToken);
        // Can also use inject() because we are in an injection context
        const valFromInject = TestBed.inject(testToken);
        return { valFromInjector, valFromInject };
      });

      expect(rootInjectables.get(key)).toEqual({
        valFromInjector: 'injected-value',
        valFromInject: 'injected-value',
      });
    });
  });

  describe('rootInjectable', () => {
    it('should create a lazy singleton injection function', () => {
      let factoryCalls = 0;

      const injectSingleton = rootInjectable((injector: Injector) => {
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
  });
});
