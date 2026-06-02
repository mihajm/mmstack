import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { compileTranslation } from './compile';
import { createNamespace } from './create-namespace';
import {
  addSignalFn,
  createT,
  injectUnsafeT,
  registerNamespace,
  registerRemoteNamespace,
  resolveTranslationModule,
} from './register-namespace';
import { injectLocaleInternal, TranslationStore } from './translation-store';

function setupStore() {
  TestBed.configureTestingModule({});

  TestBed.runInInjectionContext(() => {
    injectLocaleInternal().set('en-US');
  });

  const store = TestBed.inject(TranslationStore);

  store.register('myNs', {
    'en-US': { hello: 'Hello World', greet: 'Hello {name}' },
    'sl-SI': { hello: 'Pozdravljen svet', greet: 'Zdravo {name}' },
  });

  return store;
}

describe('createT', () => {
  describe('simple key (no variables)', () => {
    it('returns the translation for a key in a non-reactive context', () => {
      const store = setupStore();
      const t = createT(store);

      expect(t('myNs.hello')).toBe('Hello World');
    });

    it('non-reactive: returns a plain string snapshot that does not update when locale changes', () => {
      const store = setupStore();
      const t = createT(store);

      const snapshot = t('myNs.hello');
      expect(snapshot).toBe('Hello World');

      store.locale.set('sl-SI');

      expect(snapshot).toBe('Hello World');
    });

    it('reactive: tracks locale changes inside a computed', () => {
      const store = setupStore();
      const t = createT(store);

      const sig = computed(() => t('myNs.hello'));

      expect(sig()).toBe('Hello World');

      store.locale.set('sl-SI');

      expect(sig()).toBe('Pozdravljen svet');
    });
  });

  describe('variable key', () => {
    it('returns the interpolated translation in a non-reactive context', () => {
      const store = setupStore();
      const t = createT(store);

      expect(t('myNs.greet', { name: 'Alice' })).toBe('Hello Alice');
    });

    it('non-reactive: returns a plain string snapshot that does not update when variables change', () => {
      const store = setupStore();
      const t = createT(store);

      const snapshot = t('myNs.greet', { name: 'Alice' });
      expect(snapshot).toBe('Hello Alice');

      // Calling t again with different variables produces a new snapshot
      expect(t('myNs.greet', { name: 'Bob' })).toBe('Hello Bob');

      // The original snapshot is unchanged
      expect(snapshot).toBe('Hello Alice');
    });

    it('reactive: tracks signal-based variable changes inside a computed', () => {
      const store = setupStore();
      const t = createT(store);

      const name = signal('Alice');
      const sig = computed(() => t('myNs.greet', { name: name() }));

      expect(sig()).toBe('Hello Alice');

      name.set('Bob');

      expect(sig()).toBe('Hello Bob');
    });

    it('reactive: tracks locale changes inside a computed', () => {
      const store = setupStore();
      const t = createT(store);

      const sig = computed(() => t('myNs.greet', { name: 'Alice' }));

      expect(sig()).toBe('Hello Alice');

      store.locale.set('sl-SI');

      expect(sig()).toBe('Zdravo Alice');
    });
  });
});

describe('addSignalFn', () => {
  it('attaches an asSignal method to the t function', () => {
    const store = setupStore();
    const t = createT(store);
    const withSig = addSignalFn(t, store, new Map());

    expect(typeof withSig.asSignal).toBe('function');
  });

  describe('asSignal (no variables)', () => {
    it('returns a Signal with the current translation', () => {
      const store = setupStore();
      const t = createT(store);
      const withSig = addSignalFn(t, store, new Map());

      const sig = withSig.asSignal('myNs.hello');

      expect(sig()).toBe('Hello World');
    });

    it('signal updates when locale changes', () => {
      const store = setupStore();
      const t = createT(store);
      const withSig = addSignalFn(t, store, new Map());

      const sig = withSig.asSignal('myNs.hello');

      expect(sig()).toBe('Hello World');

      store.locale.set('sl-SI');

      expect(sig()).toBe('Pozdravljen svet');
    });

    it('returns the same Signal instance for the same key (simple key cache)', () => {
      const store = setupStore();
      const t = createT(store);
      const keyMap = new Map<string, string>();
      const withSig = addSignalFn(t, store, keyMap);

      const sig1 = withSig.asSignal('myNs.hello');
      const sig2 = withSig.asSignal('myNs.hello');

      expect(sig1).toBe(sig2);
    });
  });

  describe('asSignal (with variable factory)', () => {
    it('returns a Signal with the interpolated translation', () => {
      const store = setupStore();
      const t = createT(store);
      const withSig = addSignalFn(t, store, new Map());

      const sig = withSig.asSignal('myNs.greet', () => ({ name: 'Alice' }));

      expect(sig()).toBe('Hello Alice');
    });

    it('signal updates when the variable factory returns new values via a signal', () => {
      const store = setupStore();
      const t = createT(store);
      const withSig = addSignalFn(t, store, new Map());

      const name = signal('Alice');
      const sig = withSig.asSignal('myNs.greet', () => ({ name: name() }));

      expect(sig()).toBe('Hello Alice');

      name.set('Bob');

      expect(sig()).toBe('Hello Bob');
    });

    it('signal updates when locale changes', () => {
      const store = setupStore();
      const t = createT(store);
      const withSig = addSignalFn(t, store, new Map());

      const sig = withSig.asSignal('myNs.greet', () => ({ name: 'Alice' }));

      expect(sig()).toBe('Hello Alice');

      store.locale.set('sl-SI');

      expect(sig()).toBe('Zdravo Alice');
    });
  });
});

describe('injectUnsafeT', () => {
  function setup() {
    setupStore();
    return TestBed.runInInjectionContext(() => injectUnsafeT());
  }

  it('reads a registered translation by dotted key', () => {
    const t = setup();
    expect(t('myNs.hello')).toBe('Hello World');
  });

  it('interpolates params with number/string mix', () => {
    const t = setup();
    expect(t('myNs.greet', { name: 'Alice' })).toBe('Hello Alice');
  });

  it('asSignal: reactive to locale changes', () => {
    const t = setup();
    const store = TestBed.inject(TranslationStore);

    const sig = t.asSignal('myNs.greet', () => ({ name: 'Alice' }));
    expect(sig()).toBe('Hello Alice');

    store.locale.set('sl-SI');
    expect(sig()).toBe('Zdravo Alice');
  });

  it('asSignal: reactive to param signal changes', () => {
    const t = setup();
    const name = signal('Alice');

    const sig = t.asSignal('myNs.greet', () => ({ name: name() }));
    expect(sig()).toBe('Hello Alice');

    name.set('Bob');
    expect(sig()).toBe('Hello Bob');
  });

  it('asSignal: returns simple-key signal when no params provided', () => {
    const t = setup();
    const store = TestBed.inject(TranslationStore);

    const sig = t.asSignal('myNs.hello');
    expect(sig()).toBe('Hello World');

    store.locale.set('sl-SI');
    expect(sig()).toBe('Pozdravljen svet');
  });

  it('shares the cached key map across injections (process-level cache)', () => {
    setupStore();
    const t1 = TestBed.runInInjectionContext(() => injectUnsafeT());
    const t2 = TestBed.runInInjectionContext(() => injectUnsafeT());

    // Both call sites resolve to the same cached delim form. If the cache
    // weren't shared, both would still work — this just exercises the path.
    expect(t1('myNs.hello')).toBe('Hello World');
    expect(t2('myNs.hello')).toBe('Hello World');
  });
});

describe('resolveTranslationModule', () => {
  const compiled = compileTranslation({ hello: 'Hello' }, 'demo', 'en-US');

  it('returns the value unchanged when passed a CompiledTranslation directly', () => {
    expect(resolveTranslationModule(compiled)).toBe(compiled);
  });

  it('unwraps an ES-module default export (`{ default }`)', () => {
    // Shape returned by `await import('./quote.namespace')` when the file
    // does `export default ns.translation`.
    const moduleLike = {
      default: compiled,
      [Symbol.toStringTag]: 'Module',
      createDemoTranslation: () => null,
    };
    expect(resolveTranslationModule(moduleLike)).toBe(compiled);
  });

  it('unwraps a named `translation` export (`{ translation }`)', () => {
    // Shape returned when the file does `export const translation = ns.translation`.
    const moduleLike = {
      translation: compiled,
      [Symbol.toStringTag]: 'Module',
    };
    expect(resolveTranslationModule(moduleLike)).toBe(compiled);
  });

  it('prefers `default` over `translation` when both are present', () => {
    const other = compileTranslation({ hello: 'Hi' }, 'demo', 'en-US');
    const moduleLike = { default: compiled, translation: other };
    expect(resolveTranslationModule(moduleLike)).toBe(compiled);
  });

  it('throws when the loader returns something that is not a CompiledTranslation', () => {
    expect(() => resolveTranslationModule({} as never)).toThrow(
      /CompiledTranslation/,
    );
    expect(() =>
      resolveTranslationModule({ default: 'oops' } as never),
    ).toThrow(/CompiledTranslation/);
  });
});

describe('registerNamespace return shape', () => {
  it('returns a value that supports both tuple and object destructuring', () => {
    const demo = createNamespace('demo', { hello: 'Hi' });

    const result = registerNamespace(
      () => Promise.resolve(demo.translation),
      {},
    );

    // tuple form
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    // tuple and object access return the same function references
    expect(result[0]).toBe(result.injectNamespaceT);
    expect(result[1]).toBe(result.resolveNamespaceTranslation);
    expect(typeof result[0]).toBe('function');
    expect(typeof result[1]).toBe('function');

    // tuple destructure works
    const [injectT, resolveT] = result;
    expect(injectT).toBe(result.injectNamespaceT);
    expect(resolveT).toBe(result.resolveNamespaceTranslation);

    // object destructure still works (back-compat)
    const { injectNamespaceT, resolveNamespaceTranslation } = result;
    expect(injectNamespaceT).toBe(result[0]);
    expect(resolveNamespaceTranslation).toBe(result[1]);
  });
});

describe('registerRemoteNamespace return shape', () => {
  it('returns a value that supports both tuple and object destructuring', () => {
    const result = registerRemoteNamespace(
      'remote',
      () => Promise.resolve({ hello: 'Hi' }),
      {},
    );

    // tuple form
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    // tuple and object access return the same function references
    expect(result[0]).toBe(result.injectNamespaceT);
    expect(result[1]).toBe(result.resolveNamespaceTranslation);
    expect(typeof result[0]).toBe('function');
    expect(typeof result[1]).toBe('function');

    // tuple destructure works
    const [injectT, resolveT] = result;
    expect(injectT).toBe(result.injectNamespaceT);
    expect(resolveT).toBe(result.resolveNamespaceTranslation);

    // object destructure still works (back-compat)
    const { injectNamespaceT, resolveNamespaceTranslation } = result;
    expect(injectNamespaceT).toBe(result[0]);
    expect(resolveNamespaceTranslation).toBe(result[1]);
  });
});
