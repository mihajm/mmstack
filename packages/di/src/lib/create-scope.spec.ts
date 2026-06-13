import {
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  runInInjectionContext,
} from '@angular/core';
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

  it('should throw on circular dependencies between scope registrations', () => {
    const [registerScope, provideScope] = createScope('myScope');

    TestBed.configureTestingModule({ providers: [provideScope()] });

    const useA: () => unknown = registerScope(() => useB());
    const useB: () => unknown = registerScope(() => useA());

    TestBed.runInInjectionContext(() => {
      expect(() => useA()).toThrowError(
        '[mmstack/di]: Circular dependency detected in scope "myScope"'
      );
    });
  });

  it('should include the factory name in the circular dependency error when provided', () => {
    const [registerScope, provideScope] = createScope('myScope');

    TestBed.configureTestingModule({ providers: [provideScope()] });

    const useA: () => unknown = registerScope(() => useB(), 'A');
    const useB: () => unknown = registerScope(() => useA(), 'B');

    TestBed.runInInjectionContext(() => {
      expect(() => useA()).toThrowError(
        '[mmstack/di]: Circular dependency detected in scope "myScope" while resolving "A"'
      );
    });
  });

  it('should fall back to the factory function name in circular errors', () => {
    const [registerScope, provideScope] = createScope('myScope');

    TestBed.configureTestingModule({ providers: [provideScope()] });

    function namedFactory(): unknown {
      return useB();
    }
    const useA: () => unknown = registerScope(namedFactory);
    const useB: () => unknown = registerScope(() => useA());

    TestBed.runInInjectionContext(() => {
      expect(() => useA()).toThrowError(
        '[mmstack/di]: Circular dependency detected in scope "myScope" while resolving "namedFactory"'
      );
    });
  });

  it('should give each providing boundary its OWN instances (sibling isolation)', () => {
    const [registerScope, provideScope] = createScope('isolated');

    let factoryCalls = 0;
    const useItem = registerScope(() => ({ id: ++factoryCalls }));

    TestBed.configureTestingModule({});
    const parent = TestBed.inject(EnvironmentInjector);

    // two sibling boundaries — e.g. two component subtrees each providing the scope
    const a = createEnvironmentInjector([provideScope()], parent);
    const b = createEnvironmentInjector([provideScope()], parent);

    const itemA = runInInjectionContext(a, useItem);
    const itemB = runInInjectionContext(b, useItem);

    expect(itemA).not.toBe(itemB); // isolated per boundary
    expect(runInInjectionContext(a, useItem)).toBe(itemA); // cached within a boundary
    expect(factoryCalls).toBe(2);
  });

  it('should support overriding a registration at the provide boundary', () => {
    const [registerScope, provideScope] = createScope('overridable');

    const useLogger = registerScope(() => ({ kind: 'real' }), 'logger');
    const useConsumer = registerScope(() => ({ logger: useLogger() }));

    TestBed.configureTestingModule({
      providers: [
        provideScope({
          overrides: [[useLogger, () => ({ kind: 'stub' })]],
        }),
      ],
    });

    TestBed.runInInjectionContext(() => {
      expect(useLogger().kind).toBe('stub');
      // transitively: dependents resolve the override too
      expect(useConsumer().logger.kind).toBe('stub');
    });
  });

  it('should throw when an override target was not registered in the scope', () => {
    const [registerScope, provideScope] = createScope('strict');

    const useReal = registerScope(() => 1);
    const foreign = (() => 0) as () => number;

    TestBed.configureTestingModule({
      providers: [provideScope({ overrides: [[foreign, () => 2]] })],
    });

    TestBed.runInInjectionContext(() => {
      expect(() => useReal()).toThrowError(/Override target is not registered/);
    });
  });
});
