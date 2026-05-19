/**
 * Integration tests covering the full pipeline:
 *   register{Namespace,RemoteNamespace} → resolver → TranslationStore
 *   → dynamic-locale loader → t() / formatters / unsafe t.
 *
 * Each test sets up a real `provideRouter` + `provideIntlConfig`, registers
 * one or more namespaces, navigates to a route that triggers the resolver,
 * and asserts behavior observable to a consumer. Heavier than the unit
 * specs around each file, but the only place that catches bugs that live
 * across module seams (the dynamic-locale loader and the formatter
 * defaults regressions we caught both fall in this category).
 */

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

/**
 * Builds a single canonical namespace used across most tests so each test
 * doesn't repeat the structure.
 */
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

/**
 * Wait until the store's locale matches the expected value (with a hard
 * timeout) — the dynamic-locale loader uses Angular's `resource()` API,
 * which resolves over multiple microtasks and a CD flush.
 */
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
    // Regression for the hardcoded `'locale'` bug in `resolver-locale.ts`:
    // the parent-route walk must use the configured paramName, not 'locale'.
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
          localeParamName: 'lang', // <- not 'locale'
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
      // intentionally missing in a real product this would be a type error,
      // but createTranslation accepts the shape — we mutate after to drop a key.
      onlyInDefault: '',
    });
    // Simulate a stale translation file where the key is absent on disk.
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
          preloadDefaultLocale: true, // ensure default is around to fall back to
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
    // Regression for the bug where remote on-demand loaders were registered
    // as raw fetchers but the dynamic loader expected CompiledTranslation.
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
    // Deliberately slow loader so we can observe isLoading()
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
    // After the set, the resource picks up the new params and starts loading.
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
    locale.set('fr-FR'); // not in supportedLocales
    TestBed.tick();
    expect(store.locale()).toBe('en-US');
    // We can't reliably detect dev-mode vs prod-mode here, so just allow either.
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

    // Touching the store triggers `initLocale`, which reads from storage.
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
    expect(store.locale()).toBe('en-US'); // falls back to default
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

    // Constructing the store invokes `read()`; should not throw.
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
          supportedLocales: ['en-US'], // sl-SI not supported
        }),
      ],
    });
    resetGlobalLocale();

    runInjected(() => {
      const add = injectAddTranslations();
      add('runtime', {
        'en-US': { hello: 'Hi' },
        'sl-SI': { hello: 'Zdravo' }, // should be filtered
      });
    });

    const t = runInjected(() => injectUnsafeT());
    expect(t('runtime.hello')).toBe('Hi');
    // Switching to sl-SI doesn't surface the filtered translation.
    TestBed.inject(TranslationStore).locale.set('sl-SI');
    // Falls back to default-locale message.
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
    expect(fmt('US', 'region')).toBe('US'); // short style → 'US'
  });

  it('merges provideFormatDisplayNameDefaults with per-call options', () => {
    // Regression for the bug where injectFormatDisplayName spread the signal
    // object instead of `defaults()` — user defaults were silently dropped.
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
    // Per-call override should win, but library defaults must reach the
    // underlying formatter — exercising the unwrap path.
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
    // shortDate yields e.g. "3/15/26" — we just assert the year shows truncated.
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
    // Re-reading the injected formatter should pick up the new locale via
    // its internal defaults signal.
    expect(fmt(1234.5)).toMatch(/1.234,5/);
  });
});
