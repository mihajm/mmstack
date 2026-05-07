import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { addSignalFn, createT } from './register-namespace';
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
