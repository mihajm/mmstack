import { computed, LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import {
  TranslationStore,
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
});
