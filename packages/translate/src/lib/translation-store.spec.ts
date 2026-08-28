import {
  Component,
  createEnvironmentInjector,
  EnvironmentInjector,
  LOCALE_ID,
  computed,
  inject,
  runInInjectionContext,
  signal,
  type Signal,
} from '@angular/core';
import { provideLocaleSource } from './locale-source';
import {
  provideTranslationOverrides,
  type TranslationOverrides,
} from './translation-overrides';
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
  injectLocaleLoadState,
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
        expect(config?.supportedLocales).toBeUndefined();
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
      expect(store.hasLocaleLoaders('en-US')).toBe(false);
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
        const errorSpy = vi
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);

        const result = store.formatMessage('ns::MMT_DELIM::greet', {
          name: 'Alice',
        });
        expect(result).toBe('Hello Alice');

        expect(store.formatMessage('ns::MMT_DELIM::greet')).toBe(
          'Hello {name}',
        );

        errorSpy.mockRestore();
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
        expect(spy).toHaveBeenCalledTimes(1);

        fixture.componentInstance.unrelated.set(1);
        fixture.detectChanges();
        fixture.componentInstance.unrelated.set(2);
        fixture.detectChanges();
        fixture.componentInstance.unrelated.set(3);
        fixture.detectChanges();
        expect(spy).toHaveBeenCalledTimes(1);

        fixture.componentInstance.name.set('Bob');
        fixture.detectChanges();
        expect(greetEl.textContent).toBe('Hello Bob');
        expect(spy).toHaveBeenCalledTimes(2);

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
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const read = vi.fn(() => {
        throw new Error('boom');
      });
      const write = vi.fn();
      configure({ read, write });

      expect(() => TestBed.inject(TranslationStore)).not.toThrow();
      const store = TestBed.inject(TranslationStore);
      expect(store.locale()).toBe('en-US');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('swallows errors thrown from write()', () => {
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const write = vi.fn(() => {
        throw new Error('boom');
      });
      configure({ read: () => null, write });

      const store = TestBed.inject(TranslationStore);
      expect(() => {
        store.locale.set('sl-SI');
        TestBed.tick();
      }).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
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

      const sig = store.buildSimpleKeySignal('ns::MMT_DELIM::title');
      expect(sig()).toBe('Hello');
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
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      dynamicLocale.set('fr-FR');
      expect(dynamicLocale()).not.toBe('fr-FR');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should queue load when switching to supported locale', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      dynamicLocale.set('es-ES');
      expect(store.loadQueue()).toContain('es-ES');
      warnSpy.mockRestore();
    });
  });

  describe('dynamic locale loading (queue semantics)', () => {
    let store: TranslationStore;
    let dynamicLocale: ReturnType<typeof injectDynamicLocale>;

    const flush = async () => {
      for (let i = 0; i < 4; i++) {
        TestBed.tick();
        await new Promise((r) => setTimeout(r));
      }
      TestBed.tick();
    };

    beforeEach(() => {
      const routeMock = {
        snapshot: { paramMap: convertToParamMap({}) },
        paramMap: of(convertToParamMap({})),
      };
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'en-US',
            supportedLocales: ['en-US', 'de-DE', 'es-ES'],
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

    it('a missing-key fallback data load must NOT switch the active locale', async () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      store.register('home', { 'de-DE': { greeting: 'Hallo' } });
      store.locale.set('de-DE');

      expect(store.formatMessage('home::MMT_DELIM::missingKey')).toBe('');
      await flush();

      expect(store.locale()).toBe('de-DE');
      expect(store.loadQueue()).toEqual([]);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing translation'),
      );
      warnSpy.mockRestore();
    });

    it('a failed locale load dequeues and a later set() retries', async () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      let attempts = 0;
      store.registerOnDemandLoaders('feature', {
        'es-ES': () => {
          attempts++;
          if (attempts === 1) return Promise.reject(new Error('network'));
          return Promise.resolve({
            namespace: 'feature',
            flat: { msg: 'Hola' },
            locale: 'es-ES',
          });
        },
      });

      dynamicLocale.set('es-ES');
      await flush();

      expect(store.loadQueue()).toEqual([]);
      expect(store.locale()).toBe('en-US');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('again will retry'),
      );

      dynamicLocale.set('es-ES');
      await flush();

      expect(attempts).toBe(2);
      expect(store.locale()).toBe('es-ES');
      expect(store.formatMessage('feature::MMT_DELIM::msg')).toBe('Hola');

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('initial locale propagation to the compat singleton', () => {
    afterEach(() => {
      TestBed.runInInjectionContext(() => {
        injectLocaleInternal().set('en-US');
      });
    });

    it('the configured default locale reaches the deprecated global on init', () => {
      const routeMock = {
        snapshot: { paramMap: convertToParamMap({}) },
        paramMap: of(convertToParamMap({})),
      };
      TestBed.configureTestingModule({
        providers: [
          provideIntlConfig({
            defaultLocale: 'sl-SI',
            supportedLocales: ['sl-SI', 'en-US'],
          }),
          { provide: Router, useValue: { options: {} } },
          { provide: ActivatedRoute, useValue: routeMock },
        ],
      });

      TestBed.inject(TranslationStore);

      TestBed.runInInjectionContext(() => {
        expect(injectLocaleInternal()()).toBe('sl-SI');
      });
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
            messageFormatOpts: { requiresOtherClause: false },
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
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      addTranslations('remote', {
        'fr-FR': { greeting: 'Bonjour' },
      });

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

    it('replaceNamespace drops stale keys instead of merging', () => {
      store.register('live', {
        'en-US': { kept: 'old kept', stale: 'stale value' },
        'sl-SI': { kept: 'staro', stale: 'zastarelo' },
      });

      store.replaceNamespace('live', {
        'en-US': { kept: 'new kept', fresh: 'fresh value' },
      });

      expect(store.formatMessage('live::MMT_DELIM::kept')).toBe('new kept');
      expect(store.formatMessage('live::MMT_DELIM::fresh')).toBe(
        'fresh value',
      );
      expect(store.formatMessage('live::MMT_DELIM::stale')).toBe('');

      store.locale.set('sl-SI');
      // sl-SI was not part of the replacement — its old keys are gone too
      // (kept falls back to the new en-US default)
      expect(store.formatMessage('live::MMT_DELIM::kept')).toBe('new kept');
      expect(store.formatMessage('live::MMT_DELIM::stale')).toBe('');
    });

    it('replaceNamespace leaves sibling namespaces untouched', () => {
      store.register('a', { 'en-US': { key: 'a-val' } });
      store.register('ab', { 'en-US': { key: 'ab-val' } });

      store.replaceNamespace('a', { 'en-US': { key: 'a-new' } });

      expect(store.formatMessage('a::MMT_DELIM::key')).toBe('a-new');
      // 'ab' shares 'a' as a string prefix but not as a namespace
      expect(store.formatMessage('ab::MMT_DELIM::key')).toBe('ab-val');
    });

    it('select without an `other` arm is a strict enumeration', () => {
      store.register('sel', {
        'en-US': { kind: '{k, select, a {Alpha} b {Beta}}' },
      });

      expect(store.formatMessage('sel::MMT_DELIM::kind', { k: 'a' })).toBe(
        'Alpha',
      );
      expect(store.formatMessage('sel::MMT_DELIM::kind', { k: 'b' })).toBe(
        'Beta',
      );
    });

    it('select with `other`: an explicit undefined value routes to the other arm', () => {
      store.register('sel', {
        'en-US': { kind: '{k, select, a {Alpha} other {Fallback}}' },
      });

      expect(
        store.formatMessage('sel::MMT_DELIM::kind', {
          k: undefined as unknown as string,
        }),
      ).toBe('Fallback');
      expect(store.formatMessage('sel::MMT_DELIM::kind', { k: 'zzz' })).toBe(
        'Fallback',
      );
    });

    it('removeNamespace drops all keys across locales', () => {
      store.register('gone', {
        'en-US': { key: 'value' },
        'sl-SI': { key: 'vrednost' },
      });
      store.register('stays', { 'en-US': { key: 'still here' } });

      store.removeNamespace('gone');

      expect(store.formatMessage('gone::MMT_DELIM::key')).toBe('');
      expect(store.formatMessage('stays::MMT_DELIM::key')).toBe('still here');
    });
  });
});

describe('translation overrides', () => {
  const setup = (overrides: Signal<TranslationOverrides | null>) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideTranslationOverrides(overrides),
      ],
    });
    return TestBed.inject(TranslationStore);
  };

  it('overlays overrides reactively over registered translations, zero registration', () => {
    const overrides = signal<TranslationOverrides | null>({
      'en-US': { app: { title: 'Draft title', nested: { deep: 'Deep' } } },
    });
    const store = setup(overrides);
    store.register('app', {
      'en-US': { title: 'Registered title', keep: 'Kept' },
    });

    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Draft title');
    expect(store.formatMessage('app::MMT_DELIM::keep')).toBe('Kept');
    expect(store.formatMessage('app::MMT_DELIM::nested::MMT_DELIM::deep')).toBe(
      'Deep',
    );

    overrides.set({ 'en-US': { app: { title: 'Edited' } } });
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Edited');
    expect(store.formatMessage('app::MMT_DELIM::keep')).toBe('Kept');
  });

  it('null overrides fall through to registered behavior', () => {
    const overrides = signal<TranslationOverrides | null>(null);
    const store = setup(overrides);
    store.register('app', { 'en-US': { title: 'Registered' } });

    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Registered');
  });

  it('locale switch fully covered by overrides is instant — zero loading', async () => {
    const overrides = signal<TranslationOverrides | null>({
      'en-US': { app: { title: 'Title' } },
      'sl-SI': { app: { title: 'Naslov' } },
    });
    const store = setup(overrides);
    const locale = TestBed.runInInjectionContext(() => injectDynamicLocale());

    locale.set('sl-SI');

    // the switch is synchronous — no load queue, no resource round-trip
    expect(store.locale()).toBe('sl-SI');
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Naslov');

    // the loader resource never received work for this switch
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locale.isLoading()).toBe(false);
    expect(store.loadQueue()).toEqual([]);
  });
});

describe('locale source', () => {
  const setup = (source: Signal<string | null>) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI', 'de-DE'],
        }),
        provideLocaleSource(source),
        provideTranslationOverrides(
          signal<TranslationOverrides | null>({
            'en-US': { app: { title: 'Title' } },
            'sl-SI': { app: { title: 'Naslov' } },
            'de-DE': { app: { title: 'Titel' } },
          }),
        ),
      ],
    });
    return TestBed.inject(TranslationStore);
  };

  it('the source drives the locale reactively', () => {
    const source = signal<string | null>('sl-SI');
    const store = setup(source);

    expect(store.locale()).toBe('sl-SI');
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Naslov');

    source.set('de-DE');
    expect(store.locale()).toBe('de-DE');
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Titel');
  });

  it('a null source falls back to the default locale', () => {
    const source = signal<string | null>(null);
    const store = setup(source);

    expect(store.locale()).toBe('en-US');
  });

  it('local writes override until the source emits again — then the source wins', () => {
    const source = signal<string | null>('en-US');
    const store = setup(source);
    const locale = TestBed.runInInjectionContext(() => injectDynamicLocale());

    locale.set('sl-SI');
    expect(store.locale()).toBe('sl-SI');

    source.set('de-DE');
    expect(store.locale()).toBe('de-DE');
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('Titel');
  });
});

describe('scoped translation stores', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'de-DE'],
        }),
      ],
    });
  });

  it('provideIntlConfig in a child environment injector creates an independent store', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector(
      [
        provideIntlConfig({
          defaultLocale: 'sl-SI',
          supportedLocales: ['sl-SI', 'en-US'],
        }),
      ],
      root,
    );

    const rootStore = TestBed.inject(TranslationStore);
    const childStore = child.get(TranslationStore);

    expect(childStore).not.toBe(rootStore);
    expect(rootStore.locale()).toBe('en-US');
    expect(childStore.locale()).toBe('sl-SI');

    rootStore.locale.set('de-DE');
    expect(childStore.locale()).toBe('sl-SI');

    child.destroy();
  });

  it('injectDynamicLocale resolves the scope it runs in', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector(
      [
        provideIntlConfig({
          defaultLocale: 'sl-SI',
          supportedLocales: ['sl-SI', 'en-US'],
        }),
      ],
      root,
    );

    const rootLocale = TestBed.runInInjectionContext(() =>
      injectDynamicLocale(),
    );
    const childLocale = runInInjectionContext(child, () =>
      injectDynamicLocale(),
    );

    expect(rootLocale()).toBe('en-US');
    expect(childLocale()).toBe('sl-SI');

    child.destroy();
  });

  it('a child injector without its own config inherits the outer store', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const child = createEnvironmentInjector([], root);

    expect(child.get(TranslationStore)).toBe(TestBed.inject(TranslationStore));

    child.destroy();
  });
});

describe('injectLocaleLoadState', () => {
  it('exposes the ResourceLike read surface of the locale loader — and nothing mutating', () => {
    TestBed.configureTestingModule({});
    const state = TestBed.runInInjectionContext(() => injectLocaleLoadState());

    expect(typeof state.status()).toBe('string');
    expect(typeof state.isLoading()).toBe('boolean');
    expect(typeof state.hasValue()).toBe('boolean');

    expect('reload' in state).toBe(false);
    expect('destroy' in state).toBe(false);
    expect('set' in state).toBe(false);
  });
});
