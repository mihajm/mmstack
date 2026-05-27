import { Component, LOCALE_ID, computed, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import {
  TranslationStore,
  createSignalCache,
  injectAddTranslations,
  injectDefaultLocale,
  injectDynamicLocale,
  injectIntlConfig,
  injectLocaleInternal,
  injectSupportedLocales,
  provideIntlConfig,
} from './translation-store';

describe('translation-store', () => {
  describe('provideIntlConfig', () => {
    it('should provide intl config and omit defaultLocale if missing', () => {
      TestBed.configureTestingModule({
        providers: [provideIntlConfig({})],
      });

      TestBed.runInInjectionContext(() => {
        const config = injectIntlConfig();
        expect(config).toBeDefined();
        expect(config?.supportedLocales).toBeUndefined(); // It gets updated in factory? No, if supportedLocales is missing, it doesn't add defaultLocale
      });
    });

    it('should provide defaultLocale as LOCALE_ID and update supportedLocales', () => {
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'fr-FR',
            supportedLocales: ['en-US'],
          }),
        ],
      });

      TestBed.runInInjectionContext(() => {
        const config = injectIntlConfig();
        expect(config?.supportedLocales).toContain('fr-FR');
        expect(config?.supportedLocales).toContain('en-US');

        const localeId = TestBed.inject(LOCALE_ID);
        expect(localeId).toBe('fr-FR');
      });
    });
  });

  describe('injection tokens', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'de-DE',
            supportedLocales: ['de-DE', 'en-US'],
          }),
        ],
      });
    });

    it('should inject correct default locale', () => {
      TestBed.runInInjectionContext(() => {
        expect(injectDefaultLocale()).toBe('de-DE');
      });
    });

    it('should inject correct supported locales', () => {
      TestBed.runInInjectionContext(() => {
        expect(injectSupportedLocales()).toEqual(['de-DE', 'en-US']);
      });
    });
  });

  describe('TranslationStore', () => {
    let store: TranslationStore;

    beforeEach(() => {
      // Mock router dependencies which format/pathParam might need
      const routeMock = {
        snapshot: { paramMap: convertToParamMap({}) },
        paramMap: of(convertToParamMap({})),
      };
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US', 'es-ES'],
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });

      // Need to reset internal locale signal before each test to prevent bleed
      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
      });
      store = TestBed.inject(TranslationStore);
    });

    it('should initialize with default locale', () => {
      expect(store.locale()).toBe('en-US');
    });

    it('should register and format static messages', () => {
      store.register('home', {
        'en-US': { greeting: 'Welcome', goodbye: 'Bye {name}' },
        'es-ES': { greeting: 'Bienvenido' },
      });

      expect(store.formatMessage('home::MMT_DELIM::greeting')).toBe('Welcome');
      expect(
        store.formatMessage('home::MMT_DELIM::goodbye', { name: 'John' }),
      ).toBe('Bye John');

      // Update locale
      store.locale.set('es-ES');
      expect(store.formatMessage('home::MMT_DELIM::greeting')).toBe(
        'Bienvenido',
      );
    });

    it('should fallback to default locale if message is missing in current locale', () => {
      store.register('home', {
        'en-US': { fallbackMsg: 'I am fallback', greeting: 'Hello' },
        'es-ES': { greeting: 'Bienvenido' },
      });

      store.locale.set('es-ES');
      expect(store.formatMessage('home::MMT_DELIM::fallbackMsg')).toBe(
        'I am fallback',
      );
    });

    it('should register on demand loaders and track them', () => {
      store.registerOnDemandLoaders('feature', {
        'es-ES': () =>
          Promise.resolve({ namespace: 'feature', flat: { msg: 'Hola' } }),
      });

      expect(store.hasLocaleLoaders('es-ES')).toBe(true);
      expect(store.hasLocaleLoaders('en-US')).toBe(false); // No loader registered for en-US under any namespace
    });

    describe('buildSimpleKeySignal', () => {
      beforeEach(() => {
        store.register('ns', {
          'en-US': { title: 'Hello' },
          'es-ES': { title: 'Hola' },
        });
      });

      it('returns a signal with the current translation value', () => {
        const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        expect(sig()).toBe('Hello');
      });

      it('returns the same signal instance for the same key (cache)', () => {
        const sig1 = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        const sig2 = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        expect(sig1).toBe(sig2);
      });

      it('returns distinct signals for different keys', () => {
        store.register('ns', { 'en-US': { other: 'World' } });
        const sig1 = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        const sig2 = store.buildSimpleKeySignal('ns::MMT_DELIM::other');
        expect(sig1).not.toBe(sig2);
      });

      it('signal updates reactively when locale changes', () => {
        const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        expect(sig()).toBe('Hello');

        store.locale.set('es-ES');
        expect(sig()).toBe('Hola');
      });

      it('signal updates reactively when new translations are registered', () => {
        const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
        expect(sig()).toBe('Hello');

        store.register('ns', { 'en-US': { title: 'Hi there' } });
        expect(sig()).toBe('Hi there');
      });
    });

    describe('buildParamKeySignal', () => {
      beforeEach(() => {
        store.register('ns', {
          'en-US': { greet: 'Hello {name}', bye: 'Bye {name}' },
          'es-ES': { greet: 'Hola {name}', bye: 'Adios {name}' },
        });
      });

      it('returns the same signal instance for the same (key, params reference)', () => {
        const params = { name: 'Alice' };
        const r1 = store.buildParamKeySignal('ns::MMT_DELIM::greet', params);
        const r2 = store.buildParamKeySignal('ns::MMT_DELIM::greet', params);
        expect(r1.signal).toBe(r2.signal);
        expect(r1.container).toBe(r2.container);
        expect(r1.signal()).toBe('Hello Alice');
      });

      it('returns distinct signals when the params object reference differs', () => {
        const r1 = store.buildParamKeySignal('ns::MMT_DELIM::greet', {
          name: 'Alice',
        });
        const r2 = store.buildParamKeySignal('ns::MMT_DELIM::greet', {
          name: 'Alice',
        });
        expect(r1.signal).not.toBe(r2.signal);
        // Same key → same container instance even when params reference differs.
        expect(r1.container).toBe(r2.container);
        expect(r1.signal()).toBe('Hello Alice');
        expect(r2.signal()).toBe('Hello Alice');
      });

      it('shares a single params object across multiple keys (class-field aliasing)', () => {
        const params = { name: 'Alice' };
        const greet = store.buildParamKeySignal(
          'ns::MMT_DELIM::greet',
          params,
        );
        const bye = store.buildParamKeySignal('ns::MMT_DELIM::bye', params);
        expect(greet.signal).not.toBe(bye.signal);
        // Different keys → different containers.
        expect(greet.container).not.toBe(bye.container);
        expect(greet.signal()).toBe('Hello Alice');
        expect(bye.signal()).toBe('Bye Alice');
      });

      it('signal updates reactively when locale changes', () => {
        const params = { name: 'Alice' };
        const { signal: sig } = store.buildParamKeySignal(
          'ns::MMT_DELIM::greet',
          params,
        );
        expect(sig()).toBe('Hello Alice');

        store.locale.set('es-ES');
        expect(sig()).toBe('Hola Alice');
      });
    });

    describe('formatMessage', () => {
      beforeEach(() => {
        store.register('ns', {
          'en-US': { title: 'Hello', greet: 'Hello {name}' },
          'es-ES': { title: 'Hola', greet: 'Hola {name}' },
        });
      });

      it('without variables: delegates to buildSimpleKeySignal and is reactive inside a computed', () => {
        const sig = computed(() => store.formatMessage('ns::MMT_DELIM::title'));
        expect(sig()).toBe('Hello');

        store.locale.set('es-ES');
        expect(sig()).toBe('Hola');
      });

      it('without variables: returns the same value as buildSimpleKeySignal()()', () => {
        const fromSignal = store.buildSimpleKeySignal('ns::MMT_DELIM::title')();
        const fromFormat = store.formatMessage('ns::MMT_DELIM::title');
        expect(fromFormat).toBe(fromSignal);
      });

      it('with variables: interpolates and does not populate the simple-key cache', () => {
        const result = store.formatMessage('ns::MMT_DELIM::greet', {
          name: 'Alice',
        });
        expect(result).toBe('Hello Alice');

        // The key should not be in the simple-key cache — a subsequent no-variable
        // call should still resolve correctly (not blow up from a missing cache entry).
        expect(store.formatMessage('ns::MMT_DELIM::greet')).toBe(
          'Hello {name}',
        );
      });

      it('with variables: locale switch produces updated output on next call', () => {
        expect(
          store.formatMessage('ns::MMT_DELIM::greet', { name: 'Alice' }),
        ).toBe('Hello Alice');

        store.locale.set('es-ES');
        expect(
          store.formatMessage('ns::MMT_DELIM::greet', { name: 'Alice' }),
        ).toBe('Hola Alice');
      });
    });

    // End-to-end proof that `t({ ... })` calls behave as if pure in templates:
    // Angular Ivy emits `ɵɵpureFunctionN` for inline object literals (including
    // in function-argument position), giving the same params reference back
    // across CD passes until inputs change. Combined with `paramKeyMap`,
    // unrelated CD ticks should NOT re-run the ICU formatter.
    describe('template integration: pure-function memoization', () => {
      it('does not re-run formatMessageInternal when an unrelated signal triggers CD', () => {
        store.register('ns', {
          'en-US': { greet: 'Hello {name}' },
        });

        @Component({
          // eslint-disable-next-line @angular-eslint/component-selector
          selector: 'tpl-host',
          template: `
            <span class="g">{{
              store.formatMessage('ns::MMT_DELIM::greet', { name: name() })
            }}</span>
            <span class="u">{{ unrelated() }}</span>
          `,
        })
        class Host {
          store = inject(TranslationStore);
          name = signal('Alice');
          unrelated = signal(0);
        }

        const spy = vi.spyOn(
          store as unknown as {
            formatMessageInternal: (
              k: string,
              v?: Record<string, string | number>,
            ) => string;
          },
          'formatMessageInternal',
        );

        const fixture = TestBed.createComponent(Host);
        fixture.detectChanges();

        const greetEl = fixture.nativeElement.querySelector(
          '.g',
        ) as HTMLElement;
        expect(greetEl.textContent).toBe('Hello Alice');
        // One format call for the initial render.
        expect(spy).toHaveBeenCalledTimes(1);

        // Trigger CD via a signal that's NOT in the params object. Angular's
        // pureFunction1 must return the cached `{ name: 'Alice' }` reference,
        // paramKeyMap must hit, and the inner computed must short-circuit.
        fixture.componentInstance.unrelated.set(1);
        fixture.detectChanges();
        fixture.componentInstance.unrelated.set(2);
        fixture.detectChanges();
        fixture.componentInstance.unrelated.set(3);
        fixture.detectChanges();
        expect(spy).toHaveBeenCalledTimes(1);

        // Changing the params input invalidates pureFunction1 → new object
        // reference → paramKeyMap miss → fresh format call.
        fixture.componentInstance.name.set('Bob');
        fixture.detectChanges();
        expect(greetEl.textContent).toBe('Hello Bob');
        expect(spy).toHaveBeenCalledTimes(2);

        // Setting back to 'Alice' is another distinct paramFunction1 output
        // (the previous obj has been replaced in the LView slot), so it's a
        // fresh miss. This documents the invalidation granularity.
        fixture.componentInstance.name.set('Alice');
        fixture.detectChanges();
        expect(greetEl.textContent).toBe('Hello Alice');
        expect(spy).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('localeStorage', () => {
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({}) },
      paramMap: of(convertToParamMap({})),
    };

    beforeEach(() => {
      TestBed.resetTestingModule();
    });

    function configure(
      localeStorage: { read: () => string | null; write: (l: string) => void },
      supportedLocales: string[] = ['en-US', 'sl-SI', 'de-DE'],
    ) {
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales,
            localeStorage,
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });

      // Ensure clean module-level signal before construction
      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
      });
    }

    it('applies stored locale on init when supported', () => {
      const read = vi.fn(() => 'sl-SI');
      const write = vi.fn();
      configure({ read, write });

      const store = TestBed.inject(TranslationStore);
      expect(read).toHaveBeenCalledTimes(1);
      expect(store.locale()).toBe('sl-SI');
    });

    it('falls back to default when read() returns null', () => {
      const read = vi.fn(() => null);
      const write = vi.fn();
      configure({ read, write });

      const store = TestBed.inject(TranslationStore);
      expect(store.locale()).toBe('en-US');
    });

    it('ignores stored locale not in supportedLocales', () => {
      const read = vi.fn(() => 'fr-FR');
      const write = vi.fn();
      configure({ read, write }, ['en-US', 'sl-SI']);

      const store = TestBed.inject(TranslationStore);
      expect(store.locale()).toBe('en-US');
    });

    it('writes locale to storage when it changes', () => {
      const write = vi.fn();
      configure({ read: () => null, write });

      const store = TestBed.inject(TranslationStore);
      TestBed.tick();
      write.mockClear();

      store.locale.set('sl-SI');
      TestBed.tick();

      expect(write).toHaveBeenCalledWith('sl-SI');
    });

    it('swallows errors thrown from read()', () => {
      const read = vi.fn(() => {
        throw new Error('boom');
      });
      const write = vi.fn();
      configure({ read, write });

      expect(() => TestBed.inject(TranslationStore)).not.toThrow();
      const store = TestBed.inject(TranslationStore);
      expect(store.locale()).toBe('en-US');
    });

    it('swallows errors thrown from write()', () => {
      const write = vi.fn(() => {
        throw new Error('boom');
      });
      configure({ read: () => null, write });

      const store = TestBed.inject(TranslationStore);
      expect(() => {
        store.locale.set('sl-SI');
        TestBed.tick();
      }).not.toThrow();
    });
  });

  describe('createSignalCache factory', () => {
    it('strong mode: behaves like a plain Map', () => {
      const cache = createSignalCache<{ id: number }>(false);
      const v = { id: 1 };
      cache.set('a', v);
      expect(cache.get('a')).toBe(v);
      expect(cache.get('missing')).toBeUndefined();

      const v2 = { id: 2 };
      cache.set('a', v2);
      expect(cache.get('a')).toBe(v2);
    });

    it('weak mode: get returns the value while a strong reference exists', () => {
      const cache = createSignalCache<{ id: number }>(true);
      const v = { id: 1 };
      cache.set('a', v);
      // We hold a strong ref via `v`, so deref must succeed.
      expect(cache.get('a')).toBe(v);
      expect(cache.get('missing')).toBeUndefined();
    });
  });

  describe('releaseCachedSignals (weak-cache opt-in)', () => {
    const routeMock = {
      snapshot: { paramMap: convertToParamMap({}) },
      paramMap: of(convertToParamMap({})),
    };

    beforeEach(() => {
      TestBed.resetTestingModule();
    });

    function configure(releaseCachedSignals: boolean | undefined) {
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US'],
            releaseCachedSignals,
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });
      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
      });
      return TestBed.inject(TranslationStore);
    }

    it('cacheIsWeak defaults to false when the config flag is unset', () => {
      const store = configure(undefined);
      expect(store.cacheIsWeak).toBe(false);
    });

    it('cacheIsWeak is true when releaseCachedSignals is enabled', () => {
      const store = configure(true);
      expect(store.cacheIsWeak).toBe(true);
    });

    it('weak mode: formatMessage still memoizes simple keys while caller holds the signal', () => {
      const store = configure(true);
      store.register('ns', { 'en-US': { title: 'Hello' } });

      // Pin via a local variable so the WeakRef doesn't drop the signal mid-test.
      const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
      expect(sig()).toBe('Hello');
      // Second lookup must hit the same cache entry — pinning keeps the
      // WeakRef live, and the cache must return the same Signal instance.
      const sig2 = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
      expect(sig2).toBe(sig);
    });

    it('weak mode: formatMessage with params still memoizes per (key, params reference)', () => {
      const store = configure(true);
      store.register('ns', { 'en-US': { greet: 'Hello {name}' } });

      const params = { name: 'Alice' };
      const a = store.buildParamKeySignal('ns::MMT_DELIM::greet', params);
      const b = store.buildParamKeySignal('ns::MMT_DELIM::greet', params);
      expect(a.signal).toBe(b.signal);
      expect(a.container).toBe(b.container);
      expect(a.signal()).toBe('Hello Alice');
    });
  });

  describe('injectDynamicLocale', () => {
    let dynamicLocale: ReturnType<typeof injectDynamicLocale>;
    let store: TranslationStore;

    beforeEach(() => {
      const routeMock = {
        snapshot: { paramMap: convertToParamMap({}) },
        paramMap: of(convertToParamMap({})),
      };
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US', 'es-ES'],
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });

      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
        dynamicLocale = injectDynamicLocale();
        store = TestBed.inject(TranslationStore);
      });
    });

    it('should prevent switching to unsupported locales', () => {
      dynamicLocale.set('fr-FR');
      // Should remain the same as fr-FR is not in supportedLocales
      expect(dynamicLocale()).not.toBe('fr-FR');
    });

    it('should queue load when switching to supported locale', () => {
      dynamicLocale.set('es-ES');
      // Should be queued in loadQueue since there are no loaders yet
      expect(store.loadQueue()).toContain('es-ES');
      // Locale itself doesn't change until loaded (or if it has loaders)
    });
  });

  describe('injectAddTranslations', () => {
    let addTranslations: ReturnType<typeof injectAddTranslations>;
    let store: TranslationStore;

    beforeEach(() => {
      const routeMock = {
        snapshot: { paramMap: convertToParamMap({}) },
        paramMap: of(convertToParamMap({})),
      };
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US', 'sl-SI'],
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });

      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
        addTranslations = injectAddTranslations();
        store = TestBed.inject(TranslationStore);
      });
    });

    it('should add translations for supported locales', () => {
      addTranslations('remote', {
        'en-US': { greeting: 'Hi {name}' },
        'sl-SI': { greeting: 'Zdravo {name}' },
      });

      expect(
        store.formatMessage('remote::MMT_DELIM::greeting', { name: 'John' }),
      ).toBe('Hi John');

      store.locale.set('sl-SI');
      expect(
        store.formatMessage('remote::MMT_DELIM::greeting', { name: 'John' }),
      ).toBe('Zdravo John');
    });

    it('should ignore translations for unsupported locales', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
        // noop
      });

      addTranslations('remote', {
        'fr-FR': { greeting: 'Bonjour' },
      });

      // It shouldn't be possible to get 'Bonjour' since fr-FR is not supported
      store.locale.set('en-US');
      expect(store.formatMessage('remote::MMT_DELIM::greeting')).toBe('');

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should allow adding translations to multiple namespaces', () => {
      addTranslations('ns1', { 'en-US': { key: 'val1' } });
      addTranslations('ns2', { 'en-US': { key: 'val2' } });

      expect(store.formatMessage('ns1::MMT_DELIM::key')).toBe('val1');
      expect(store.formatMessage('ns2::MMT_DELIM::key')).toBe('val2');
    });
  });
});
