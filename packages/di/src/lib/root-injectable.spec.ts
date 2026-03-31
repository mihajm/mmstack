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
  });
});
