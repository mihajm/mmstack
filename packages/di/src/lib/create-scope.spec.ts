import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createScope } from './create-scope';

describe('createScope', () => {
  it('should create a scope that caches the factory result', () => {
    const [registerScope, provideScope] = createScope('myScope');

    TestBed.configureTestingModule({
      providers: [provideScope()],
    });

    let factoryCalls = 0;
    const useScopedItem = registerScope(() => {
      factoryCalls++;
      return { id: factoryCalls };
    });

    TestBed.runInInjectionContext(() => {
      const item1 = useScopedItem();
      const item2 = useScopedItem();

      expect(item1).toEqual({ id: 1 });
      expect(item1).toBe(item2); // It should return the exact same instance
      expect(factoryCalls).toBe(1);
    });
  });

  it('should run the factory in the injection context so it can use inject()', () => {
    const [registerScope, provideScope] = createScope('myScope');
    
    TestBed.configureTestingModule({
      providers: [
        provideScope(),
        { provide: 'TEST_DEP', useValue: 'dependency_value' }
      ]
    });

    const useScopedItem = registerScope(() => {
      const dep = inject('TEST_DEP' as any);
      return { value: dep };
    });

    TestBed.runInInjectionContext(() => {
      expect(useScopedItem()).toEqual({ value: 'dependency_value' });
    });
  });

  it('should throw an error if the scope provider is missing', () => {
    const [registerScope] = createScope('customScopeName');

    const useScopedItem = registerScope(() => 'test');

    TestBed.runInInjectionContext(() => {
      expect(() => useScopedItem()).toThrowError(
        '[mmstack/di]: Scope customScopeName not found. Please make sure you provide it'
      );
    });
  });

  it('should throw an error with "unknown" as the name if no name was provided', () => {
    const [registerScope] = createScope(); // no name provided

    const useScopedItem = registerScope(() => 'test');

    TestBed.runInInjectionContext(() => {
      expect(() => useScopedItem()).toThrowError(
        '[mmstack/di]: Scope unknown not found. Please make sure you provide it'
      );
    });
  });
});
