# @mmstack/translate

**Type-Safe & modular localization for Modern Angular.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Ftranslate.svg)](https://badge.fury.io/js/%40mmstack%2Ftranslate)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

`@mmstack/translate` is an opinionated internationalization (i18n) library for Angular applications. It uses the **FormatJS** Intl runtime (`@formatjs/intl`) for ICU message formatting and integrates with Angular's dependency injection, routing, and signals.

## Features

- ✅ **End-to-End Type Safety:** Compile-time checks for:
  - Translation key existence (within a namespace).
  - Correct parameter names and types.
  - Required vs. optional parameters based on ICU message.
  - Structural consistency check when defining non-default locales.
- 🚀 **Flexible Deployment:** Support both multi-build (traditional) and single-build (runtime) scenarios.
- 📦 **Namespacing:** Organize translations by feature/library (e.g., 'quotes', 'userProfile', 'common').
- 🔄 **Dynamic Language Switching (Optional):** Change locales at runtime with automatic translation loading.
- 🛣️ **Route-Based Locale Support (Optional):** Automatic locale detection and switching based on route parameters.
- ⏳ **Lazy Loading:** Load namespaced translations on demand using Route Resolvers.
- ✨ **Reactive API:** Includes `t.asSignal()` for creating computed translation signals based on signal parameters.
- 🌍 **ICU Message Syntax:** Uses FormatJS runtime for robust support of variables (`{name}`), `plural`, `select`, and `selectordinal`. (Note: Complex inline date/number formats are not the focus; use Angular's built-in Pipes/format functions & use the result as variables in your translation.)
- 🔗 **Shared Namespace Support:** Define common translations (e.g., 'Save', 'Cancel') in one namespace and make them type-safely accessible from others.
- 🛠️ **Template Helpers:** Includes abstract `Translator` pipe and `Translate` directive for easy, type-safe templating.
- 🔢 **Reactive Formatters:** First-class, Intl-based, locale-aware formatters for dates, numbers, currencies, percentages, lists, and relative time — all automatically reactive to locale changes via signals, no zone or common/locale dependency required.

## Installation

Install the library & its peer dependency, `@formatjs/intl`.

```bash
npm install @mmstack/translate @formatjs/intl
```

## Table of contents

- [Configuration](#configuration) — multi-build (default) or single-build with `provideIntlConfig`
- [Usage](#usage) — defining namespaces, registering them, reading translations
- [Example configurations](#example-configurations) — full configs for the two most common scenarios
- [Helper functions](#helper-functions) — `injectDefaultLocale`, `injectIntl`, `injectDynamicLocale`, `canMatchLocale`
- [Formatters](#formatters) — reactive `Intl.*` wrappers for date, number, currency, percent, list, relative time, display name
- [Remote / unsafe namespaces](#remote--unsafe-namespaces) — for translations whose keys aren't known at build time
- [Escape hatches](#escape-hatches) — `withParams`, `injectAddTranslations`, `injectUnsafeT`
- [Testing](#testing) — `provideMockTranslations`
- [Architecture & performance](#advanced-architecture--performance)
- [Migration from other libraries](#migration-from-other-libraries)
- [Alternatives & comparison](#alternatives--comparison)

## Configuration

### Default: Multi-Build Scenario (like @angular/localize)

By default, `@mmstack/translate` works like `@angular/localize` - it uses Angular's `LOCALE_ID` token and expects a page refresh for locale changes. This is ideal for traditional multi-build deployments where each locale has its own build artifact.

**No special configuration needed!** Just provide `LOCALE_ID`:

```typescript
// app.config.ts
import { ApplicationConfig, LOCALE_ID } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'en-US' }, // Set your locale
    // ... other providers
  ],
};
```

The library will use this `LOCALE_ID` value and work exactly like `@angular/localize` - requiring a full page refresh to change locales.

### Single-Build with Runtime Translation Loading

If you want a **single build** that loads translations at runtime, use `provideIntlConfig()`:

```typescript
// app.config.ts
import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideIntlConfig } from '@mmstack/translate';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'en-US' }, // Initial/fallback locale
    provideIntlConfig({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI', 'de-DE', 'fr-FR'], // Validates locale switches
    }),
    // ... other providers
  ],
};
```

**Additional options:**

- **`localeParamName`** — drive the active locale from a route parameter. See [Route-based locale detection](#4-optional-route-based-locale-detection) and [Scenario A](#scenario-a-route-based-locale).
- **`localeStorage`** — persist the user-selected locale across reloads via a `read` / `write` adapter. See [Dynamic language switching](#5-optional-dynamic-language-switching) and [Scenario B](#scenario-b-dynamic-locale-with-localstorage-persistence). Mutually exclusive with `localeParamName`.
- **`preloadDefaultLocale: true`** — eagerly load the default-locale bundle so it's available as a synchronous fallback. Rarely needed.
- **`releaseCachedSignals: true`** — opt into lifecycle-aware caching so cached translation signals can be collected when no live component still uses them. Default `false` is the right choice for almost every app; turn this on only for very large apps with measured memory pressure or when constructing translation keys dynamically. See [Cache lifetime](#cache-lifetime--releasecachedsignals).

## Usage

The core workflow involves defining namespaces, registering them (often via lazy loading), and then using the injected translation function (t), pipe, or directive.

### 1. Define Namespace & Translations

Define your default locale translations (e.g., 'en-US') as a `const` TypeScript object. Use `createNamespace` to process it and generate helpers.

```typescript
// Example: packages/quote/src/lib/quote.namespace.ts
import { createNamespace } from '@mmstack/translate';

// Create the namespace definition object
const ns = createNamespace('quote', {
  pageTitle: 'Famous Quotes',
  greeting: 'Hello {name}!',
  detail: {
    authorLabel: 'Author',
  },
  errors: {
    minLength: 'Quote must be at least {min} characters long.',
  },
  stats: '{count, plural, one {# quote} other {# quotes}} available',
});

export default ns.translation;

export type QuoteLocale = (typeof ns)['translation'];

export const createQuoteTranslation = ns.createTranslation;
```

**Define other locales in separate files** (for lazy loading):

```typescript
// packages/quote/src/lib/quote-sl.translation.ts
import { createQuoteTranslation } from './quote.namespace';

// Shape is type-safe (errors if you have missing or additional keys)
export default createQuoteTranslation('sl-SI', {
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}!',
  detail: {
    authorLabel: 'Avtor',
  },
  errors: {
    minLength: 'Citat mora imeti vsaj {min} znakov.', // Variables must match original
  },
  stats:
    '{count, plural, =1 {# citat} =2 {# citata} few {# citati} other {# citatov}} na voljo',
});
```

### 2. Register the Namespace & Load Translations

Use `registerNamespace` to prepare your namespace definition and obtain the `injectT` function plus the route `resolve` function. The return value supports both tuple and object destructuring — tuple destructuring lets each call site pick its own names, which is the recommended form when you have more than one namespace:

```typescript
// Example: packages/quote/src/lib/quote.t.ts
import { registerNamespace } from '@mmstack/translate';

export const [injectQuoteT, resolveQuoteTranslations] = registerNamespace(
  // Default locale (also acts as the fallback).
  () => import('./quote.namespace'),
  {
    // Other locales — each value is a `() => Promise<...>` factory.
    'sl-SI': () => import('./quote-sl.translation'),
    // Add more locales as needed...
  },
);
```

The object form (`{ injectNamespaceT, resolveNamespaceTranslation }`) still works for backwards compatibility — handy when you only have one namespace and don't need to rename.

Each loader can return either a `CompiledTranslation` directly, or an ES module exposing one as `default` or as a named `translation` export. So all three of these are equivalent:

```typescript
() => import('./quote.namespace'),                       // ES module with `export default`
() => import('./quote.namespace').then((m) => m.default), // explicit unwrap (still supported)
() => import('./quote.namespace').then((m) => m.translation), // for files using `export const translation`
```

Bare dynamic imports are the most ergonomic; the explicit forms continue to work and can be useful when a single module re-exports several namespaces.

**Add the resolver to your routes:**

```typescript
// quote.routes.ts
import { type Routes } from '@angular/router';
import { resolveQuoteTranslations } from './quote.t';

export const QUOTE_ROUTES: Routes = [
  {
    path: '',
    component: QuoteComponent,
    resolve: {
      translations: resolveQuoteTranslations, // Loads translations before component
    },
  },
];
```

#### 2b. [OPTIONAL] Configure Type-Safe Pipe and/or Directive

```typescript
import { Pipe, Directive } from '@angular/core';
import { Translator, Translate } from '@mmstack/translate';
import { type QuoteLocale } from './quote.namespace';

@Pipe({
  name: 'translate',
})
export class QuoteTranslator extends Translator<QuoteLocale> {}

@Directive({
  selector: '[translate]', // Input in Translate is named 'translate'
})
export class QuoteTranslate<TInput extends string> extends Translate<
  TInput,
  QuoteLocale
> {}
```

### 3. Use Translations in Components

```typescript
import { Component, signal } from '@angular/core';
import { injectQuoteT } from './quote.t';
import { QuoteTranslator, QuoteTranslate } from './quote.helpers';

@Component({
  selector: 'app-quote',
  imports: [QuoteTranslator, QuoteTranslate],
  template: `
    <!-- t() is safe to call directly in templates. Variable-free keys and
         keys with an inline params literal are both memoized internally and
         reactive to locale changes. -->
    <h1>{{ t('quote.pageTitle') }}</h1>
    <span>{{ t('quote.detail.authorLabel') }}</span>

    <!-- Inline params work too. Angular emits ɵɵpureFunctionN for the {...}
         literal, so the same object reference is handed back across change
         detection passes when inputs are unchanged — the library keys its
         cache on that identity, so the ICU formatter only runs when values
         actually change. See "Translation memoization" in the architecture
         section for details. -->
    <span>{{ t('quote.errors.minLength', { min: '5' }) }}</span>

    <!-- t.asSignal() is the right tool when you want to hold a Signal<string>
         in a class field (e.g. to pass as an @Input) or when params are built
         from a fresh object each call (structural equality on the params
         signal short-circuits recomputes). -->

    <!-- Pipe validates key & variables match -->
    <span>{{ 'quote.errors.minLength' | translate: { min: '5' } }}</span>

    <!-- Directive replaces textContent of element -->
    <h1 translate="quote.pageTitle"></h1>
    <span [translate]="['quote.errors.minLength', { min: '5' }]"></span>
  `,
})
export class QuoteComponent {
  protected readonly count = signal(0);

  // Must be protected/public to be accessible from the template
  protected readonly t = injectQuoteT();

  // performance best case, but only useful in a compiled locale scenario (when using LOCALE_ID)
  protected readonly title = t('quote.pageTitle');

  // For variable keys (or optimization scenarios), use asSignal() — it memoizes the result and only
  // re-evaluates when the signal-based parameters actually change. If no variables are provided it basically
  // recomputes only on locale changes
  protected readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // Must match ICU parameter (type: number)
  }));
}
```

**When to use each API:**

| Scenario                                                 | Recommended API                                              |
| :------------------------------------------------------- | :----------------------------------------------------------- |
| Variable-free key in a template                          | `{{ t('ns.key') }}`                                          |
| Variable-free key in class logic                         | `this.t('ns.key')`                                           |
| Key with variables in a template (inline `{...}`)        | `{{ t('ns.key', { var: val() }) }}`                          |
| Key you want as a `Signal<string>` (class field, inputs) | `this.t.asSignal('ns.key', () => ({ var: val() }))`          |
| Key with variables in class logic (one-shot read)        | `this.t('ns.key', { var })`                                  |
| Type-safe pipe (with or without variables)               | `'ns.key' \| translate` / `'ns.key' \| translate: vars`      |
| Structural DOM replacement                               | `<el translate="ns.key">` / `[translate]="['ns.key', vars]"` |

> **Inline `t('ns.key', { ... })` in templates is fine.** Angular Ivy emits `ɵɵpureFunctionN` for inline object literals (including in function-argument position), giving stable reference identity across change-detection passes when the literal's inputs are unchanged. The library keys its params cache on that identity, so unchanged params skip the ICU formatter entirely. Use `t.asSignal()` when you specifically need a `Signal<string>` (e.g. to expose to `@Input`s) or when you're constructing params from a fresh object each call and want the structural-equality short-circuit.

### 4. [OPTIONAL] Route-Based Locale Detection

For applications with locale-based routing (e.g. `/en-US/quotes`, `/sl-SI/quotes`), the library can detect and switch locales automatically:

- Set `localeParamName` in `provideIntlConfig({ ... })` — the store will react to that route param.
- Wire `canMatchLocale()` as a `canMatch` guard on the route that owns the locale segment — it validates against `supportedLocales` and redirects invalid locales to the default.

See [Scenario A](#scenario-a-route-based-locale) for a complete end-to-end config.

**Locale parameter not in the first position?** Pass the leading static segments to `canMatchLocale`:

```typescript
{
  path: 'app/:locale',
  canMatch: [canMatchLocale(['app'])], // matches the segment after 'app'
  children: [...]
}
```

### 5. [OPTIONAL] Dynamic Language Switching

For runtime language switching without page refreshes (e.g. a language picker in the header), `injectDynamicLocale()` returns a `WritableSignal<string>` with an attached `isLoading: Signal<boolean>`. Setting it triggers automatic loading of any missing namespace translations for the new locale; setting it to a value not in `supportedLocales` is a no-op (with a dev-mode warning).

```typescript
const locale = injectDynamicLocale();
locale.set('sl-SI'); // missing translations load automatically
if (locale.isLoading()) { /* show a spinner */ }
```

Pair with `localeStorage` in `provideIntlConfig({ ... })` to persist the user's choice across reloads — `read()` runs once on init, `write()` fires on every successful change. Stored values are validated against `supportedLocales`; errors from `read()`/`write()` are swallowed (and dev-mode logged) so a misbehaving backend can't break the app. `localeStorage` is mutually exclusive with `localeParamName` at the type level.

See [Scenario B](#scenario-b-dynamic-locale-with-localstorage-persistence) for a complete app config plus a language-switcher component.

**Note for pure pipes:** Angular memoizes pure pipes by input identity, so they don't naturally re-evaluate when only the store's locale signal changes. Two ways out:

```typescript
// Recommended: pass locale as a pipe argument so the input identity changes.
{{ 'common.yes' | translate : locale() }}

// Alternative: opt the pipe out of memoization (slower; re-runs every CD cycle).
@Pipe({ name: 'translate', pure: false })
export class QuoteTranslator extends Translator<QuoteLocale> {}
```

### 6. [OPTIONAL] Creating a Shared/Common Namespace

A shared namespace allows you to define common translations (e.g., 'Save', 'Cancel', 'Yes', 'No') once and use them type-safely across all other namespaces.

**Step 1: Define a shared namespace**

```typescript
// packages/common/src/lib/common.namespace.ts
import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('common', {
  yes: 'Yes',
  no: 'No',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
});

export default ns.translation;
export type CommonLocale = (typeof ns)['translation'];
export const createCommonTranslation = ns.createTranslation;

// Export this for other namespaces to use
export const createAppNamespace = ns.createMergedNamespace;
```

**Step 2: Register the common namespace at the top level**

```typescript
// common.t.ts
import { registerNamespace } from '@mmstack/translate';

export const [injectCommonT, resolveCommonTranslations] = registerNamespace(
  () => import('./common.namespace'),
  {
    'sl-SI': () => import('./common-sl.translation'),
  },
);
```

```typescript
// app.routes.ts - resolve at top level
export const routes: Routes = [
  {
    path: '',
    resolve: {
      common: resolveCommonTranslations, // Load common translations first
    },
    children: [
      // ... other routes
    ],
  },
];
```

**Step 3: Use the shared namespace factory in other namespaces**

```typescript
// packages/quote/src/lib/quote.namespace.ts
import { createAppNamespace } from '@org/common'; // Your import path

const ns = createAppNamespace('quote', {
  pageTitle: 'Famous Quotes',
  // ... other translations
});

export default ns.translation;
// ... rest remains the same
```

**Step 4: Access both namespaces in components**

```typescript
@Component({...})
export class QuoteComponent {
  private readonly t = injectQuoteT();

  // Access common namespace translations
  private readonly yesLabel = this.t('common.yes');
  private readonly saveLabel = this.t('common.save');

  // Access quote namespace translations
  private readonly title = this.t('quote.pageTitle');
}
```

## Example configurations

Two end-to-end app configs covering the most common single-build scenarios. Copy either as a starting point.

### Scenario A: Route-based locale

The locale lives in the URL (`/en-US/quotes`, `/sl-SI/quotes`), the router guard validates it, and the resolver picks it up automatically. Best when you want shareable, SEO-friendly locale URLs.

```typescript
// app.config.ts
import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIntlConfig } from '@mmstack/translate';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'en-US' }, // initial / fallback locale
    provideIntlConfig({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI', 'de-DE'],
      localeParamName: 'locale', // store reacts to this route param
    }),
    provideRouter(routes),
  ],
};
```

```typescript
// app.routes.ts
import { Routes } from '@angular/router';
import { canMatchLocale } from '@mmstack/translate';

export const routes: Routes = [
  {
    path: ':locale',
    canMatch: [canMatchLocale()], // redirects invalid locales to default
    children: [
      {
        path: 'quotes',
        loadChildren: () =>
          import('./quote/quote.routes').then((m) => m.QUOTE_ROUTES),
      },
      // ... other locale-scoped routes
    ],
  },
];
```

Visiting `/sl-SI/quotes` triggers the resolver, which loads the `sl-SI` translation and switches the store's locale. Visiting `/zz-ZZ/quotes` is redirected to `/en-US/quotes` by the guard.

### Scenario B: Dynamic locale with localStorage persistence

The locale lives in a writable signal driven by the user (typically a language picker), and the choice survives reloads. Best when the locale isn't part of the URL.

```typescript
// app.config.ts
import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIntlConfig } from '@mmstack/translate';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'en-US' }, // initial / fallback locale
    provideIntlConfig({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI', 'de-DE'],
      localeStorage: {
        read: () => localStorage.getItem('locale'),
        write: (locale) => localStorage.setItem('locale', locale),
      },
    }),
    provideRouter(routes),
  ],
};
```

```typescript
// language-switcher.component.ts
import { Component } from '@angular/core';
import { injectDynamicLocale } from '@mmstack/translate';

@Component({
  selector: 'app-language-switcher',
  template: `
    <select [value]="locale()" (change)="onChange($event)">
      <option value="en-US">English</option>
      <option value="sl-SI">Slovenščina</option>
      <option value="de-DE">Deutsch</option>
    </select>
    @if (locale.isLoading()) { <span>Loading…</span> }
  `,
})
export class LanguageSwitcherComponent {
  protected readonly locale = injectDynamicLocale();

  protected onChange(event: Event) {
    this.locale.set((event.target as HTMLSelectElement).value);
  }
}
```

`localeStorage.read()` runs once on init to restore the previous choice (silently ignored if not in `supportedLocales`); `write()` fires on every successful locale change. `localeStorage` and `localeParamName` are mutually exclusive at the type level — when the URL is the source of truth, persisting separately would just fight it.

## Helper Functions

### Core Injection Functions

**`injectDefaultLocale(): string`**  
Returns the configured default locale or falls back to `LOCALE_ID`.

**`injectSupportedLocales(): string[]`**  
Returns the array of supported locales or defaults to `[defaultLocale]`.

**`injectIntl(): Signal<IntlShape>`**  
Directly access the FormatJS `Intl` instance for advanced formatting needs.

```typescript
import { injectIntl } from '@mmstack/translate';

const intl = injectIntl();
const formatted = intl().formatNumber(1234.56, {
  style: 'currency',
  currency: 'EUR',
});
```

**`injectDynamicLocale(): WritableSignal<string> & { isLoading: Signal<boolean> }`**  
Inject a dynamic locale signal for runtime language switching.

### Route Utilities

**`canMatchLocale(prefixSegments?: string[]): CanMatchFn`**  
Route guard that validates locale parameters against `supportedLocales` and redirects invalid locales to the default.

## Advanced: Architecture & Performance

### Resource-Based Translation Loading

The library uses Angular's `resource()` API for efficient, reactive translation loading:

- Automatic request deduplication
- Built-in loading states
- Stale-result discarding via `AbortSignal` (the abort signal is checked after each load resolves; in-flight `fetch` cancellation isn't propagated to user-supplied loaders)
- Better error handling

### On-Demand Translation Loading

When switching locales dynamically, the library:

1. Checks which namespaces need translations for the new locale
2. Loads only the missing translations in parallel
3. Updates all reactive outputs automatically
4. Falls back to the default locale if unavailable

### Translation Memoization

Both `t('ns.key')` and `t('ns.key', { ... })` are memoized — the ICU formatter only runs when the active locale changes or when the params object's values change. Repeated change-detection passes are effectively free. `t.asSignal()` is the right tool when you want a `Signal<string>` (class field, `@Input`) or when you're building params from non-stable references and want structural-equality short-circuiting.

### Cache Lifetime & `releaseCachedSignals`

By default, the internal translation-signal caches grow with the set of keys ever read and are never evicted. For almost every app this is the right default — translation keys are a bounded, static set, the cache converges quickly, and the hot path stays as cheap as possible.

For very large apps (tens of thousands of keys) or apps that construct translation keys dynamically, you can opt into lifecycle-aware caching:

```typescript
provideIntlConfig({
  defaultLocale: 'en-US',
  supportedLocales: ['en-US', 'sl-SI'],
  releaseCachedSignals: true,
});
```

When enabled, cached signals are released once no live component is still using them, so the effective memory bound becomes "signals used by currently-mounted components" instead of "all keys ever read." Cost is a few extra nanoseconds per cache hit — imperceptible in practice. Leave it off unless you've measured memory pressure from translation caches.

## Remote / Unsafe Namespaces

For cases where you need to load translations from a remote API (where keys aren't known at compile-time), use `registerRemoteNamespace`. This provides an untyped experience but allows you to integrate dynamic content into the same system.

```typescript
import { registerRemoteNamespace } from '@mmstack/translate';

// Returns an untyped t function: t('any.key')
const [injectRemoteT] = registerRemoteNamespace(
  'remote',
  () => fetch('/api/en').then((r) => r.json()),
  {
    'sl-SI': () => fetch('/api/sl').then((r) => r.json()),
  },
);

// usage
const t = injectRemoteT();

// .asSignal variants also work
const value = t('remote.myKey');
const valueThatNeedsProps = t('remote.myOtherKey', {
  name: 'John',
});
```

## Formatters

The library includes a set of reactive formatters that wrap the standard `Intl.*` APIs and integrate with the dynamic locale signal.

Available formatters:

- **`formatDate`**: Wraps `Intl.DateTimeFormat`
- **`formatNumber`**: Wraps `Intl.NumberFormat`
- **`formatCurrency`**: Wraps `Intl.NumberFormat` (currency style)
- **`formatPercent`**: Wraps `Intl.NumberFormat` (percent style)
- **`formatList`**: Wraps `Intl.ListFormat`
- **`formatRelativeTime`**: Wraps `Intl.RelativeTimeFormat`
- **`formatDisplayName`**: Wraps `Intl.DisplayNames`

Each formatter ships in two flavors:

1. **Standalone function** (`formatDate`, `formatList`, …) — pass `locale` explicitly, either as a string or via the options object. Three overloads per formatter: `(value, locale)`, `(value, opt)` with a required `locale` field, and a deprecated unsafe form that omits the locale (kept for backwards compatibility, see SSR note below).
2. **`injectFormat*()` companion** (`injectFormatDate`, `injectFormatList`, …) — call inside an injection context to get a function that auto-resolves locale from `injectDynamicLocale()` and respects any defaults registered via `provideFormat*Defaults`. **This is the recommended path for components and services.**

You can grab them all at once via the `injectFormatters()` facade:

```typescript
import { computed, signal } from '@angular/core';
import { injectFormatters } from '@mmstack/translate';

export class MyComponent {
  private readonly fmt = injectFormatters();

  readonly price = signal(1234.56);
  readonly date = new Date();

  // Reacts to price changes AND locale changes — no explicit locale needed
  readonly displayPrice = computed(() => this.fmt.currency(this.price(), 'EUR'));
  readonly displayDate = computed(() => this.fmt.date(this.date));
}
```

If you'd rather call the standalone forms (e.g. outside an injection context), pass the locale explicitly:

```typescript
import { computed } from '@angular/core';
import { formatCurrency, formatDate, injectDynamicLocale } from '@mmstack/translate';

const locale = injectDynamicLocale();

readonly displayPrice = computed(() => formatCurrency(this.price(), 'EUR', { locale: locale() }));
readonly displayDate = computed(() => formatDate(this.date, locale()));
```

### Provider defaults

Each formatter has a paired `provideFormat*Defaults` provider, and they can be registered together via `provideFormatDefaults`:

```typescript
import { provideFormatDefaults } from '@mmstack/translate';

bootstrapApplication(AppComponent, {
  providers: [
    provideFormatDefaults({
      date: { format: 'mediumDate' },
      number: { useGrouping: true, maxFractionDigits: 2 },
      currency: { display: 'code' },
      relativeTime: { numeric: 'auto' },
      list: { type: 'disjunction' },
      percent: { maxFractionDigits: 1 },
      displayName: { style: 'short' },
    }),
  ],
});
```

The injected formatter functions (`injectFormat*()`) automatically merge these defaults with the dynamic locale.

### SSR note

The deprecated unsafe overload (omitting `locale`) reads from a **process-level global signal**, which can cross-contaminate concurrent requests on a single-process Node.js SSR server rendering pages for different locales. The new overloads with required `locale` and the `injectFormat*()` companions are SSR-safe.

For SSR-bound code, prefer either:

```typescript
// 1. Recommended — let the injected formatter handle locale
private readonly formatDate = injectFormatDate();
readonly displayDate = computed(() => this.formatDate(this.date));

// 2. Or pass locale explicitly to the standalone function
readonly displayDate = computed(() => formatDate(this.date, this.currentLocale()));
```

The unsafe overload is kept for backwards compatibility and will be removed in a future release.

## Testing

When testing components that use `@mmstack/translate` (via `injectNamespaceT`, `Translate` directive, or `Translator` pipe), you don't need to configure actual translated namespaces or deal with Intl loading. Instead, use the provided `provideMockTranslations()` utility.

```typescript
import { TestBed } from '@angular/core/testing';
import { provideMockTranslations } from '@mmstack/translate';
import { MyComponent } from './my.component';

describe('MyComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MyComponent],
      providers: [
        // Automatically intercepts translation logic & skips real loading
        provideMockTranslations(),
      ],
    });
  });

  it('should render translation keys directly', () => {
    const fixture = TestBed.createComponent(MyComponent);
    fixture.detectChanges();

    // By default, it echoes back the flattened object key using dot notation
    expect(fixture.nativeElement.textContent).toContain(
      'myNamespace.greeting.title',
    );
  });

  it('allows providing explicit mock overrides', () => {
    TestBed.configureTestingModule({
      providers: [
        provideMockTranslations({
          translations: {
            myNamespace: { greeting: { title: 'Mocked Title' } },
          },
        }),
      ],
    });

    const fixture = TestBed.createComponent(MyComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Mocked Title');
  });

  it('supports real ICU interpolation with formatValues', () => {
    TestBed.configureTestingModule({
      providers: [
        provideMockTranslations({
          translations: {
            myNamespace: { greeting: { title: 'Hello {name}!' } },
          },
          formatValues: true, // enables @formatjs/intl processing
        }),
      ],
    });

    const fixture = TestBed.createComponent(MyComponent);
    fixture.detectChanges();
    // Variables like {name} are now interpolated via @formatjs/intl
    expect(fixture.nativeElement.textContent).toContain('Hello World!');
  });
});
```

## Migration from Other Libraries

### From @angular/localize

You don't have to change your build pipeline — `@mmstack/translate` runs alongside (or in place of) `@angular/localize` in multi-build mode without rebuilds. The migration happens at the source level: replace `$localize` template tags and `i18n` attributes with namespace-based access.

| `@angular/localize`                            | `@mmstack/translate`                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| ``$localize`Hello ${name}:name:` ``            | `t('quote.greeting', { name })`                                                   |
| `<h1 i18n>Title</h1>`                          | `<h1 [translate]="'quote.title'">` / `{{ t('quote.title') }}` / pipe              |
| `messages.xlf` extraction                      | TypeScript: `createNamespace('quote', { ... })`                                   |
| `messages.<locale>.xlf` translation file       | TS file: `createQuoteTranslation('sl-SI', { ... })`                               |
| `angular.json` `localize` config (multi-build) | Same multi-build still works; or switch to a single build with `provideIntlConfig` |
| `<my-cmp i18n-title title="Hi">`               | Bind the title from a translation: `[title]="t('ns.greeting')"`                   |

**ICU plurals and selects use the same syntax** — no conversion. They're now type-checked end to end, which the `@angular/localize` extractor doesn't provide.

**No auto-extraction.** Translation files are authored as TypeScript, so the compiler enforces shape consistency and parameter coverage across locales — at the cost of losing the `ng extract-i18n` workflow. For greenfield namespaces this is usually a net win; for huge existing xlf catalogs, plan a one-time script to convert them.

### From @jsverse/transloco

Conceptually close — both are runtime, signal-aware, and namespace/scope-based. The main shift is from JSON files + a service API to TypeScript namespaces + an injected `t` function:

| transloco                                                | `@mmstack/translate`                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `provideTransloco({ ... })`                              | `provideIntlConfig({ ... })`                                          |
| `scope` (e.g. `'lazy-page'`)                             | `namespace` (first arg to `createNamespace` / `registerNamespace`)    |
| JSON translation files                                   | TS namespace files (default + one per other locale)                   |
| `inject(TranslocoService).translate(key, params)`        | `injectQuoteT()(...)` (typed `t` from `registerNamespace`)            |
| `translateSignal(key, params)` / `*transloco`            | `t.asSignal(key, () => params)` / `Translate` directive               |
| `transloco` pipe                                         | `Translator` pipe (typed subclass)                                    |
| `TranslocoService.activeLang` signal                     | `injectDynamicLocale()` (writable signal)                             |
| `TranslocoService.langChanges$`                          | `effect(() => locale())`                                              |
| HTTP-loader-based lazy scope                             | Dynamic `import()` factory passed to `registerNamespace`              |
| `*translocoLoading`                                      | `locale.isLoading()` signal on `injectDynamicLocale`                  |

Migration sketch:

1. Pick a locale strategy and configure `provideIntlConfig` accordingly (see [Example configurations](#example-configurations)).
2. For each transloco scope: convert the JSON into a `createNamespace('<name>', defaultTranslations)` file plus one `createXTranslation('<locale>', ...)` file per non-default locale.
3. In each scope's loader module, call `registerNamespace(() => import('./<ns>.namespace'), { ... })` and tuple-destructure the result into your own names (e.g. `export const [injectScopeT, resolveScopeT] = registerNamespace(...)`). Wire the resolver into the matching route.
4. Replace `TranslocoService.translate` / `translateSignal` calls with the injected typed `t`. Replace the `transloco` pipe and `*transloco` directive with typed subclasses of `Translator` and `Translate`.

### From ngx-translate

Same source-level shape change as transloco but with more legacy API surface to replace:

| ngx-translate                                       | `@mmstack/translate`                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `TranslateModule.forRoot({ loader: ... })`          | `provideIntlConfig` + per-namespace `registerNamespace`                           |
| `TranslateService.get(key, params)` (Observable)    | `t('ns.key', params)` (plain string) or `t.asSignal(...)` (Signal)                |
| `TranslateService.instant(key, params)`             | `t('ns.key', params)`                                                             |
| `TranslateService.use('locale')`                    | `injectDynamicLocale().set('locale')`                                             |
| `TranslateService.onLangChange.subscribe(...)`      | `effect(() => locale())`                                                          |
| `TranslateHttpLoader`                               | Dynamic `import()` factory: `() => import('./ns.<locale>').then((m) => m.default)`|
| `translate` pipe                                    | Typed `Translator` pipe subclass                                                  |
| `MissingTranslationHandler`                         | Falls back to the default-locale message; dev-mode `console.warn`                 |

Migration sketch:

1. Convert each JSON translation file to TypeScript with `createNamespace` (default locale) + `createXTranslation` (other locales). The compiler enforces parameter and shape consistency.
2. Replace `TranslateService` usage with the typed `t` from `registerNamespace`. RxJS observables become plain strings (eager) or signals (`t.asSignal(...)`).
3. Replace `TranslateHttpLoader` with dynamic `import()` factories — your bundler code-splits each locale automatically; no HTTP fetch needed.
4. Pick a locale strategy: [route-based](#scenario-a-route-based-locale) (`canMatchLocale` + `localeParamName`) or [dynamic with persistence](#scenario-b-dynamic-locale-with-localstorage-persistence) (`injectDynamicLocale` + `localeStorage`).
5. Swap the `translate` pipe usage for a typed `Translator` pipe subclass (per namespace). Pure-pipe locale memoization needs the `locale()` argument trick — see [Step 5](#5-optional-dynamic-language-switching).

## Escape Hatches

Sometimes we all hit the limit of an api & need imperative escape hatches for those edge cases. These are the ones mmstack/translate currently provides:

**`withParams()`**

Type-level parameter inference is one level deep — variables inside `plural` / `select` / `selectordinal` arms aren't picked up (e.g. the `{name}` inside `{count, plural, one {Hi {name}} ...}`). For those cases, wrap the message with `withParams<P>(...)` to declare the missing params explicitly:

```typescript
import { createNamespace, withParams } from '@mmstack/translate';

const ns = createNamespace('quote', {
  // auto-extracts `count`; `name` is declared because it lives inside the arms
  stats: withParams<{ name: string }>(
    '{count, plural, one {1 quote from {name}} other {# quotes from {name}}}',
  ),
});

// t inferred as: ('quote.stats', { count: number; name: string }) => string
t('quote.stats', { count: 3, name: 'Alice' });
```

Declared params are merged with auto-extracted ones; on key conflict, declared wins. Non-default locales for a wrapped key don't need to repeat the helper — they accept any string:

```typescript
createQuoteTranslation('sl-SI', {
  stats: '{count, plural, =1 {1 citat od {name}} other {# citatov od {name}}}',
});
```

Trade-off: wrapping a key opts out of template-literal shape strictness for that key in non-default locales (the auto-validation that requires placeholders to appear in the right positions). The library still enforces top-level placeholders for non-wrapped keys.

**`injectAddTranslations()`**
Allows adding flat, per-locale translations to any namespace at runtime.

```typescript
import { injectAddTranslations } from '@mmstack/translate';

const addTranslations = injectAddTranslations();
addTranslations('dynamicNs', {
  'en-US': { greeting: 'Hello {name}!' },
  'sl-SI': { greeting: 'Zdravo {name}!' },
});
```

**`injectUnsafeT()`**
Returns a fully untyped translation function `t('anyNamespace.key')`. Ideal for reading dynamically added keys or cross-namespace lookups where the typed API would be impractical.

```typescript
import { injectUnsafeT } from '@mmstack/translate';

const t = injectUnsafeT();
const greeting = t('dynamicNs.greeting', { name: 'Alice' });
const signalGreeting = t.asSignal('dynamicNs.greeting', () => ({
  name: 'Alice',
}));
```

## Alternatives & comparison

`@mmstack/translate` fills a specific niche: supporting **both** traditional multi-build and modern single-build approaches with a typesafe & modular API, well-suited to nx-based environments. The table below positions it relative to the main alternatives.

| Feature                  |         `@mmstack/translate`         |      `@angular/localize`      |                                         `@jsverse/transloco`                                         |       `ngx-translate`       |
| :----------------------- | :----------------------------------: | :---------------------------: | :--------------------------------------------------------------------------------------------------: | :-------------------------: |
| **Build Process**        |       ✅ Single or Multi-Build       |   ❌ Multi-Build (Typical)    |                                           ✅ Single Build                                            |       ✅ Single Build       |
| **Translation Timing**   |        Runtime or Build Time         |         Compile Time          |                                               Runtime                                                |           Runtime           |
| **Type Safety (Keys)**   | ✅ Strong (Inferred from structure)  |       🟡 via extraction       |                                         🟡 Tooling/TS Files                                          |    🟡 OK Manual/Tooling     |
| **Type Safety (Params)** |    ✅ Strong (Inferred from ICU)     |            ❌ None            |                                              🟡 Manual                                               |          🟡 Manual          |
| **Locale Switching**     | ✅ Dynamic (Runtime) or Page refresh |   🔄 Page Refresh Required    |                                         ✅ Dynamic (Runtime)                                         |    ✅ Dynamic (Runtime)     |
| **Lazy Loading**         |  ✅ Built-in (Namespaces/Resolvers)  |      N/A (Compile Time)       |                                         ✅ Built-in (Scopes)                                         |   ✅ Yes (Custom Loaders)   |
| **Namespacing/Scopes**   |             ✅ Built-in              |            ❌ None            |                                         ✅ Built-in (Scopes)                                         | 🟡 Manual (File Structure)  |
| **ICU Support**          |   ✅ Subset (via FormatJS Runtime)   |     ✅ Yes (Compile Time)     |                                    ✅ Yes (Runtime Intl/Plugins)                                     |      🟡 Via Extensions      |
| **Signal Integration**   |      ✅ Great (fully reactive)       |              N/A              |                          ✅ Good (`translateSignal()`, `activeLang` signal)                          |      ❌ Minimal/None¹       |
| **Reactive Formatters**  |     ✅ Built-in Intl integration     | 🟡 Angular pipes (zone-based) | ✅ @jsverse/transloco-locale(`transloco-locale`²: date/number/currency/percent, not signal-reactive) | ❌ None (use Angular pipes) |
| **Maturity / Community** |  🟡 Less mature, but battle tested   |         Core Angular          |                                          ✅ Mature / Active                                          |          ✅ Mature          |

## Contributing

Contributions, issues, and feature requests are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT © [Miha Mulec](https://github.com/mihajm)
