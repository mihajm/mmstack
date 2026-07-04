import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
import { createNamespace } from './create-namespace';
import { injectFormatDate, provideFormatDateDefaults } from './format/date';
import {
  injectFormatDisplayName,
  provideFormatDisplayNameDefaults,
} from './format/display-name';
import {
  injectFormatNumber,
  provideFormatNumberDefaults,
} from './format/numeric';
import {
  registerNamespace,
  registerRemoteNamespace,
  injectUnsafeT,
} from './register-namespace';
import {
  TranslationStore,
  injectAddTranslations,
  injectDynamicLocale,
  injectLocaleInternal,
  provideIntlConfig,
} from './translation-store';

@Component({ template: '' })
class DummyComponent {}

function buildQuoteNamespace() {
  const ns = createNamespace('quote', {
    pageTitle: 'Famous Quotes',
    greeting: 'Hello {name}',
    detail: {
      authorLabel: 'Author',
    },
  });

  return {
    enUS: ns.translation,
    slSI: ns.createTranslation('sl-SI', {
      pageTitle: 'Znani Citati',
      greeting: 'Zdravo {name}',
      detail: { authorLabel: 'Avtor' },
    }),
    deDE: ns.createTranslation('de-DE', {
      pageTitle: 'Berühmte Zitate',
      greeting: 'Hallo {name}',
      detail: { authorLabel: 'Autor' },
    }),
    createTranslation: ns.createTranslation,
  };
}

function buildCommonNamespace() {
  const ns = createNamespace('common', {
    yes: 'Yes',
    no: 'No',
    cancel: 'Cancel',
  });

  return {
    enUS: ns.translation,
    slSI: ns.createTranslation('sl-SI', {
      yes: 'Da',
      no: 'Ne',
      cancel: 'Prekliči',
    }),
  };
}

function runInjected<T>(fn: () => T): T {
  return TestBed.runInInjectionContext(fn);
}

async function waitForLocale(
  store: TranslationStore,
  expected: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (store.locale() !== expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForLocale: expected ${expected}, still ${store.locale()} after ${timeoutMs}ms`,
      );
    }
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

function resetGlobalLocale() {
  TestBed.runInInjectionContext(() => {
    injectLocaleInternal().set('en-US');
  });
}

describe('Integration: registerNamespace through the resolver', () => {
  it('makes default-locale translations available after navigation', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: 'quotes',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/quotes');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Famous Quotes');
    expect(t('quote.greeting', { name: 'Ada' })).toBe('Hello Ada');
    expect(t('quote.detail.authorLabel')).toBe('Author');
  });

  it('accepts the bare-import loader shape (`() => import(...)`)', async () => {
    const quote = buildQuoteNamespace();
    const moduleEN = { default: quote.enUS, [Symbol.toStringTag]: 'Module' };
    const moduleSL = { default: quote.slSI, [Symbol.toStringTag]: 'Module' };

    const r = registerNamespace(
      () => Promise.resolve(moduleEN as never),
      { 'sl-SI': () => Promise.resolve(moduleSL as never) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Famous Quotes');
  });

  it('accepts the named-`translation` loader shape', async () => {
    const quote = buildQuoteNamespace();
    const moduleEN = { translation: quote.enUS };

    const r = registerNamespace(
      () => Promise.resolve(moduleEN as never),
      {},
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Famous Quotes');
  });

  it('picks up the active locale from a route parameter', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeParamName: 'locale',
        }),
        provideRouter([
          {
            path: ':locale',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/sl-SI');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Znani Citati');
    expect(t('quote.greeting', { name: 'Ada' })).toBe('Zdravo Ada');
  });

  it('resolves a custom localeParamName from a nested parent route', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeParamName: 'lang',
        }),
        provideRouter([
          {
            path: ':lang',
            component: DummyComponent,
            children: [
              {
                path: 'quotes',
                component: DummyComponent,
                resolve: { t: r.resolveNamespaceTranslation },
              },
            ],
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/sl-SI/quotes');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Znani Citati');
  });

  it('falls back to the default-locale message when the active locale is missing a key', async () => {
    const ns = createNamespace('quote', {
      pageTitle: 'Famous Quotes',
      onlyInDefault: 'Only in default',
    });
    const slPartial = ns.createTranslation('sl-SI', {
      pageTitle: 'Znani Citati',
      onlyInDefault: '',
    });
    delete (slPartial.flat as Record<string, string>)['onlyInDefault'];

    const r = registerNamespace(
      () => Promise.resolve(ns.translation),
      { 'sl-SI': () => Promise.resolve(slPartial) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeParamName: 'locale',
          preloadDefaultLocale: true,
        }),
        provideRouter([
          {
            path: ':locale',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/sl-SI');
    TestBed.tick();

    const t = runInjected(() => r.injectNamespaceT());
    expect(t('quote.pageTitle')).toBe('Znani Citati');
    expect(t('quote.onlyInDefault' as 'quote.pageTitle')).toBe(
      'Only in default',
    );
  });
});

describe('Integration: dynamic locale switching', () => {
  it('switches a typed namespace via injectDynamicLocale().set()', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const t = runInjected(() => r.injectNamespaceT());
    const locale = runInjected(() => injectDynamicLocale());

    expect(t('quote.pageTitle')).toBe('Famous Quotes');
    locale.set('sl-SI');
    await waitForLocale(store, 'sl-SI');
    expect(t('quote.pageTitle')).toBe('Znani Citati');

    locale.set('en-US');
    await waitForLocale(store, 'en-US');
    expect(t('quote.pageTitle')).toBe('Famous Quotes');
  });

  it('switches a remote (untyped) namespace via injectDynamicLocale().set()', async () => {
    const r = registerRemoteNamespace(
      'remote',
      () => Promise.resolve({ hello: 'Hello', greet: 'Hi {name}' }),
      {
        'sl-SI': () =>
          Promise.resolve({ hello: 'Pozdravljen', greet: 'Zdravo {name}' }),
      },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const t = runInjected(() => r.injectNamespaceT());
    const locale = runInjected(() => injectDynamicLocale());

    expect(t('remote.hello')).toBe('Hello');
    expect(t('remote.greet', { name: 'Ada' })).toBe('Hi Ada');

    locale.set('sl-SI');
    await waitForLocale(store, 'sl-SI');
    expect(t('remote.hello')).toBe('Pozdravljen');
    expect(t('remote.greet', { name: 'Ada' })).toBe('Zdravo Ada');
  });

  it('switches multiple namespaces atomically (each registers its own loader)', async () => {
    const quote = buildQuoteNamespace();
    const common = buildCommonNamespace();

    const rQ = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );
    const rC = registerNamespace(
      () => Promise.resolve(common.enUS),
      { 'sl-SI': () => Promise.resolve(common.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: {
              q: rQ.resolveNamespaceTranslation,
              c: rC.resolveNamespaceTranslation,
            },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const tQ = runInjected(() => rQ.injectNamespaceT());
    const tC = runInjected(() => rC.injectNamespaceT());
    const locale = runInjected(() => injectDynamicLocale());

    expect(tQ('quote.pageTitle')).toBe('Famous Quotes');
    expect(tC('common.yes')).toBe('Yes');

    locale.set('sl-SI');
    await waitForLocale(store, 'sl-SI');
    expect(tQ('quote.pageTitle')).toBe('Znani Citati');
    expect(tC('common.yes')).toBe('Da');
  });

  it('reports isLoading() true while a locale switch is in flight and false once settled', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      {
        'sl-SI': () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(quote.slSI), 30),
          ),
      },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const locale = runInjected(() => injectDynamicLocale());

    locale.set('sl-SI');
    TestBed.tick();
    expect(locale.isLoading()).toBe(true);
    await waitForLocale(store, 'sl-SI');
    expect(locale.isLoading()).toBe(false);
  });

  it('refuses to switch to a locale outside supportedLocales (no-op + dev warning)', async () => {
    const quote = buildQuoteNamespace();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const locale = runInjected(() => injectDynamicLocale());

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    locale.set('fr-FR');
    TestBed.tick();
    expect(store.locale()).toBe('en-US');
    warnSpy.mockRestore();
  });
});

describe('Integration: localeStorage persistence', () => {
  function makeMemoryStorage(initial?: string) {
    let value: string | null = initial ?? null;
    const writes: string[] = [];
    return {
      read: () => value,
      write: (next: string) => {
        value = next;
        writes.push(next);
      },
      get value() {
        return value;
      },
      writes,
    };
  }

  it('restores the previously-stored locale on init', async () => {
    const quote = buildQuoteNamespace();
    const storage = makeMemoryStorage('sl-SI');
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeStorage: { read: storage.read, write: storage.write },
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    const store = TestBed.inject(TranslationStore);
    expect(store.locale()).toBe('sl-SI');
  });

  it('writes on each successful locale change', async () => {
    const quote = buildQuoteNamespace();
    const storage = makeMemoryStorage();
    const r = registerNamespace(
      () => Promise.resolve(quote.enUS),
      { 'sl-SI': () => Promise.resolve(quote.slSI) },
    );

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeStorage: { read: storage.read, write: storage.write },
        }),
        provideRouter([
          {
            path: '',
            component: DummyComponent,
            resolve: { t: r.resolveNamespaceTranslation },
          },
        ] satisfies Routes),
      ],
    });
    resetGlobalLocale();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    const store = TestBed.inject(TranslationStore);
    const locale = runInjected(() => injectDynamicLocale());

    locale.set('sl-SI');
    await waitForLocale(store, 'sl-SI');
    expect(storage.value).toBe('sl-SI');
    expect(storage.writes).toContain('sl-SI');
  });

  it('ignores a stored locale that is not in supportedLocales', () => {
    const storage = makeMemoryStorage('zz-ZZ');

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeStorage: { read: storage.read, write: storage.write },
        }),
      ],
    });
    resetGlobalLocale();

    const store = TestBed.inject(TranslationStore);
    expect(store.locale()).toBe('en-US');
  });

  it('swallows errors thrown by the storage adapter (does not crash the app)', () => {
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
          localeStorage: {
            read: () => {
              throw new Error('storage offline');
            },
            write: () => {
              throw new Error('storage offline');
            },
          },
        }),
      ],
    });
    resetGlobalLocale();

    expect(() => TestBed.inject(TranslationStore)).not.toThrow();
    errSpy.mockRestore();
  });
});

describe('Integration: injectAddTranslations + injectUnsafeT', () => {
  it('adds translations at runtime and reads them via the untyped t', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'sl-SI'],
        }),
      ],
    });
    resetGlobalLocale();

    runInjected(() => {
      const add = injectAddTranslations();
      add('runtime', {
        'en-US': { greeting: 'Hi {name}', farewell: 'Bye' },
        'sl-SI': { greeting: 'Zdravo {name}', farewell: 'Adijo' },
      });
    });

    const t = runInjected(() => injectUnsafeT());
    expect(t('runtime.greeting', { name: 'Ada' })).toBe('Hi Ada');
    expect(t('runtime.farewell')).toBe('Bye');

    TestBed.inject(TranslationStore).locale.set('sl-SI');
    expect(t('runtime.greeting', { name: 'Ada' })).toBe('Zdravo Ada');
  });

  it('rejects translations for unsupported locales (with a dev warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
      ],
    });
    resetGlobalLocale();

    runInjected(() => {
      const add = injectAddTranslations();
      add('runtime', {
        'en-US': { hello: 'Hi' },
        'sl-SI': { hello: 'Zdravo' },
      });
    });

    const t = runInjected(() => injectUnsafeT());
    expect(t('runtime.hello')).toBe('Hi');
    TestBed.inject(TranslationStore).locale.set('sl-SI');
    expect(t('runtime.hello')).toBe('Hi');
    warnSpy.mockRestore();
  });
});

describe('Integration: formatter defaults wired through DI', () => {
  it('respects provideFormatDisplayNameDefaults when no per-call options are given', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
        provideFormatDisplayNameDefaults({ style: 'short' }),
      ],
    });
    resetGlobalLocale();

    const fmt = runInjected(() => injectFormatDisplayName());
    expect(fmt('US', 'region')).toBe('US');
  });

  it('merges provideFormatDisplayNameDefaults with per-call options', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
        provideFormatDisplayNameDefaults({ style: 'short' }),
      ],
    });
    resetGlobalLocale();

    const fmt = runInjected(() => injectFormatDisplayName());
    expect(fmt('US', 'region', { style: 'long', locale: 'en-US' })).toBe(
      'United States',
    );
  });

  it('respects provideFormatDateDefaults', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
        provideFormatDateDefaults({ format: 'shortDate' }),
      ],
    });
    resetGlobalLocale();

    const fmt = runInjected(() => injectFormatDate());
    const out = fmt(new Date('2026-03-15T00:00:00Z'));
    expect(out).toMatch(/3.*15.*26/);
  });

  it('respects provideFormatNumberDefaults', () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US'],
        }),
        provideFormatNumberDefaults({
          maxFractionDigits: 1,
          useGrouping: false,
        }),
      ],
    });
    resetGlobalLocale();

    const fmt = runInjected(() => injectFormatNumber());
    expect(fmt(1234.567)).toBe('1234.6');
  });

  it('reacts to dynamic locale changes', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideIntlConfig({
          defaultLocale: 'en-US',
          supportedLocales: ['en-US', 'de-DE'],
        }),
      ],
    });
    resetGlobalLocale();

    const fmt = runInjected(() => injectFormatNumber());
    expect(fmt(1234.5)).toBe('1,234.5');

    TestBed.inject(TranslationStore).locale.set('de-DE');
    expect(fmt(1234.5)).toMatch(/1.234,5/);
  });
});
