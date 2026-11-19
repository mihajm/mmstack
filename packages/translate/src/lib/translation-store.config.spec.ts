import { LOCALE_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslationOverrides } from './translation-overrides';
import {
  injectAddTranslations,
  injectDefaultLocale,
  injectDynamicLocale,
  injectIntl,
  injectIntlConfig,
  injectLocaleInternal,
  injectSupportedLocales,
  provideIntlConfig,
  TranslationStore,
} from './translation-store';

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
  TestBed.tick();
};

function inCtx<T>(fn: () => T): T {
  return TestBed.runInInjectionContext(fn);
}

function resetGlobal() {
  inCtx(() => injectLocaleInternal().set('en-US'));
}

describe('intl config helpers', () => {
  it('keeps the configured default in supportedLocales when LOCALE_ID is overridden', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'fr-FR',
          supportedLocales: ['en-US'],
        }),
        { provide: LOCALE_ID, useValue: 'de-DE' },
      ],
    });
    expect(inCtx(() => injectIntlConfig()?.supportedLocales)).toContain(
      'fr-FR',
    );
  });

  it('defaults to the first supported locale when defaultLocale is omitted', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ supportedLocales: ['de-DE', 'en-US'] })],
    });
    expect(inCtx(() => injectDefaultLocale())).toBe('de-DE');
  });

  it('injectSupportedLocales falls back to the default locale without a config', () => {
    TestBed.configureTestingModule({});
    expect(inCtx(() => injectSupportedLocales())).toEqual(['en-US']);
  });

  it('injectSupportedLocales falls back to the default locale without supportedLocales', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ defaultLocale: 'de-DE' })],
    });
    expect(inCtx(() => injectSupportedLocales())).toEqual(['de-DE']);
  });
});

describe('TranslationStore message formatting', () => {
  afterEach(resetGlobal);

  it('formats ICU arguments with the active locale', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ defaultLocale: 'en-US' })],
    });
    const store = TestBed.inject(TranslationStore);
    store.register('n', {
      'en-US': { v: '{n, number}' },
      'de-DE': { v: '{n, number}' },
    });
    store.locale.set('de-DE');
    expect(store.formatMessage('n::MMT_DELIM::v', { n: 1234.5 })).toBe(
      '1.234,5',
    );
  });

  it('formats a fallback message with the default locale rules', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ supportedLocales: ['sl-SI', 'en-US'] })],
    });
    const store = TestBed.inject(TranslationStore);
    store.register('n', {
      'sl-SI': { v: '{n, plural, one {ena} two {dve} few {tri} other {vec}}' },
      'en-US': { other: 'x' },
    });
    store.locale.set('en-US');
    expect(store.formatMessage('n::MMT_DELIM::v', { n: 2 })).toBe('dve');
  });

  it('skips an undefined locale entry in the overrides', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslationOverrides(
          signal({ 'en-US': { app: { title: 'T' } }, 'sl-SI': undefined }),
        ),
      ],
    });
    const store = TestBed.inject(TranslationStore);
    expect(store.formatMessage('app::MMT_DELIM::title')).toBe('T');
  });

  it('injectIntl exposes the store intl for the active locale', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ defaultLocale: 'en-US' })],
    });
    const store = TestBed.inject(TranslationStore);
    const intl = inCtx(() => injectIntl());
    store.locale.set('de-DE');
    expect(intl().locale).toBe('de-DE');
    expect(intl().formatNumber(1234.5)).toBe('1.234,5');
  });
});

describe('injectDynamicLocale', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    resetGlobal();
  });

  function setup(config: Parameters<typeof provideIntlConfig>[0]) {
    TestBed.configureTestingModule({ providers: [provideIntlConfig(config)] });
    resetGlobal();
    return inCtx(() => ({
      store: TestBed.inject(TranslationStore),
      locale: injectDynamicLocale(),
    }));
  }

  it('switches back to the default locale before any default data exists', async () => {
    const { store, locale } = setup({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'es-ES'],
    });
    store.locale.set('es-ES');
    locale.set('en-US');
    expect(store.locale()).toBe('en-US');
    await flush();
    expect(store.locale()).toBe('en-US');
  });

  it('refuses an unsupported locale without loading it', async () => {
    const { store, locale } = setup({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'es-ES'],
    });
    const loader = vi.fn(() => Promise.resolve({ namespace: 'x', flat: {} }));
    store.registerOnDemandLoaders('x', { 'fr-FR': loader });
    locale.set('fr-FR');
    await flush();
    expect(loader).not.toHaveBeenCalled();
    expect(store.locale()).toBe('en-US');
  });

  it('allows any locale with data when supportedLocales is not set', () => {
    const { store, locale } = setup({ defaultLocale: 'en-US' });
    store.register('x', { 'de-DE': { k: 'v' } });
    locale.set('de-DE');
    expect(store.locale()).toBe('de-DE');
  });

  it('update() switches like set()', () => {
    const { store, locale } = setup({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI'],
    });
    store.register('x', { 'sl-SI': { k: 'v' } });
    locale.update(() => 'sl-SI');
    expect(store.locale()).toBe('sl-SI');
  });
});

describe('injectAddTranslations without supportedLocales', () => {
  it('registers translations without any config', () => {
    TestBed.configureTestingModule({});
    inCtx(() => injectAddTranslations())('ns', { 'en-US': { k: 'v' } });
    expect(
      TestBed.inject(TranslationStore).formatMessage('ns::MMT_DELIM::k'),
    ).toBe('v');
  });

  it('registers translations with a config that has no supportedLocales', () => {
    TestBed.configureTestingModule({
      providers: [provideIntlConfig({ defaultLocale: 'en-US' })],
    });
    inCtx(() => injectAddTranslations())('ns', { 'en-US': { k: 'v' } });
    expect(
      TestBed.inject(TranslationStore).formatMessage('ns::MMT_DELIM::k'),
    ).toBe('v');
  });
});
