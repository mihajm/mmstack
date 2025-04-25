# @mmstack/translate

**Type-Safe & modular localization for Modern Angular.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Ftranslate.svg)](https://badge.fury.io/js/%40mmstack%2Ftranslate)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

`@mmstack/translate` is an opinionated internationalization (i18n) library for Angular applications built with three core priorities:

1.  **Maximum Type Safety:** Catch errors related to missing keys or incorrect/missing parameters at compile time.
2.  **Simplified Build Process:** Lazily load translations at runtime, requiring only a **single application build** regardless of the number of supported locales.
3.  **Scalable Modularity:** Organize translations into **namespaces** (typically aligned with feature libraries) and load them on demand.

It uses the robust **FormatJS** Intl runtime (`@formatjs/intl`) for ICU message formatting, and integrates with Angular's dependency injection and routing.

## Features

- ✅ **End-to-End Type Safety:** Compile-time checks for:
  - Translation key existence (within a namespace).
  - Correct parameter names and types.
  - Required vs. optional parameters based on ICU message.
  - Structural consistency check when defining non-default locales.
- 🚀 **Single Build Artifact:** Runtime translation loading.
- 📦 **Namespacing:** Organize translations by feature/library (e.g., 'quotes', 'userProfile', 'common').
- ⏳ **Lazy Loading:** Load namespaced translations on demand using Route Resolvers.
- ✨ **Reactive API:** Includes `t.asSignal()` for creating computed translation signals based on signal parameters.
- 🌍 **ICU Message Syntax:** Uses FormatJS runtime for robust support of variables (`{name}`), `plural`, `select`, and `selectordinal`. (Note: Complex inline date/number formats are not the focus; use Angular's built in Pipes/format functions & use the result as variables in your translation.)
- 🔗 **Shared Namespace Support:** Define common translations (e.g., 'Save', 'Cancel') in one namespace and make them type-safely accessible from others.
- 🛠️ **Template Helpers:** Includes abstract `BaseTranslatePipe` and `BaseTranslateDirective` for easy, type-safe templating.

### Comparison

While Angular offers excellent i18n solutions like `@angular/localize` and `transloco`, `@mmstack/translate` aims to fill a specific niche.

| Feature                  |        `@mmstack/translate`         |   `@angular/localize`    |          `transloco`          |      `ngx-translate`       |
| :----------------------- | :---------------------------------: | :----------------------: | :---------------------------: | :------------------------: |
| **Build Process**        |           ✅ Single Build           | ❌ Multi-Build (Typical) |        ✅ Single Build        |      ✅ Single Build       |
| **Translation Timing**   |               Runtime               |       Compile Time       |            Runtime            |          Runtime           |
| **Type Safety (Keys)**   | ✅ Strong (Inferred from structure) |    🟡 via extraction     |      🟡 Tooling/TS Files      |    🟡 OK Manual/Tooling    |
| **Type Safety (Params)** |    ✅ Strong (Inferred from ICU)    |         ❌ None          |           🟡 Manual           |         🟡 Manual          |
| **Locale Switching**     |      🔄 Page Refresh Required       | 🔄 Page Refresh Required |     ✅ Dynamic (Runtime)      |    ✅ Dynamic (Runtime)    |
| **Lazy Loading**         | ✅ Built-in (Namespaces/Resolvers)  |    N/A (Compile Time)    |     ✅ Built-in (Scopes)      |  ✅ Yes (Custom Loaders)   |
| **Namespacing/Scopes**   |             ✅ Built-in             |         ❌ None          |     ✅ Built-in (Scopes)      | 🟡 Manual (File Structure) |
| **ICU Support**          |  ✅ Subset (via FormatJS Runtime)   |  ✅ Yes (Compile Time)   | ✅ Yes (Runtime Intl/Plugins) |     🟡 Via Extensions      |
| **Signal Integration**   |      ✅ Good (`t.asSignal()`)       |           N/A            | ✅ Good (`translateSignal()`) |      ❌ Minimal/None       |
| **Maturity / Community** |               ✨ New                |       Core Angular       |      ✅ Mature / Active       |         ✅ Mature          |

## Installation & Configuration

Install the library & its peer dependency, `@formatjs/intl`.

```bash
npm install @mmstack/translate @formatjs/intl
```

If you'd like to setup @formatjs with custom properties & setup a different default locale then 'en-US' you can define these options at the root of your application.

```typescript
import { provideIntlConfig } from '@mmstack/translate';

const appConfig: Providers = [
  provideIntlConfig({
    defaultLocale: 'fr-FR', // defaults to 'en-US' if nothing is provided
  }),
];
```

```typescript
import { Component, LOCALE_ID } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

const KNOWN_LOCALES = ['en-US', 'sl-SI'];

@Component({
  selector: 'app-locale-shell',
  providers: [
    {
      provide: LOCALE_ID,
      useFactory: (route: ActivatedRoute) => {
        const locale = route.snapshot.paramMap.get('locale') || 'en-US';
        if (KNOWN_LOCALES.includes(locale)) return locale;
        return 'en-US';
      },
      deps: [ActivatedRoute],
    },
  ],
  template: `<ng-content />`,
})
export class LocaleShellComponent {}
```

_Note:_ `@mmstack/translate` relies on Angular's `LOCALE_ID` provider. You must provide a value for it. How you determine this value (e.g., hardcoded, from server config, from URL segment via a factory provider) is up to your application's architecture. The library assumes this `LOCALE_ID` is static for the duration of the application session and requires a page refresh to change.

## Usage

The core workflow involves defining namespaces, registering them (often via lazy loading), and then using the injected translation function (t), pipe, or directive.

### 1. Define Namespace & Translations

Define your default locale translations (e.g., 'en-US') as a `const` TypeScript object. Use createNamespace to process it and generate helpers.

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
} as const); // Note the as const, without it variable inference won't work correctly

export default ns.translation;

export type QuoteLocale = (typeof ns)['translation'];

export const createQuoteTranslation = ns.createTranslation;

// Note the translations should be in separate files, if you are using import() to lazy load them.
// packages/quote/src/lib/quote-sl.translation.ts

import { createQuoteTranslation } from './quote.namespace';

// shape is typesafe (errors if you have missing or additional keys)
export default createQuoteTranslation({
  pageTitle: 'Znani Citati',
  greeting: 'Zdravo {name}!',
  detail: {
    authorLabel: 'Avtor',
  },
  errors: {
    minLength: 'Citat mora imeti vsaj {min} znakov.', // If original has variables, the translation must contain a subset of used variables (min 1)
  },
  stats: '{count, plural, =1 {# citat} =2 {# citata} few {# citati} other {# citatov}} na voljo', // also guarenteed for "complex" variables, so {count} must be used in this translation
});
```

### 2. Register the namespace & load

Use registerNamespace to prepare your namespace definition and obtain the injectNamespaceT function and the resolveNamespaceTranslation resolver function. Use the resolver in your Angular routes.

```typescript
import q from './quote.namespace';

// Register the namespace
// Example: packages/quote/src/lib/quote.t.ts
const r = registerNamespace(
  q, // Default locale's compiled translation (functions as fallback if no locale of type provided)
  {
    // Map other locales to promise factories (dynamic imports)
    'sl-SI': () => import('./quote-sl.translation.ts').then((m) => m.default),
  },
);

export const injectQuoteT = r.injectNamespaceT;
export const resolveQuoteTranslations = r.resolveNamespaceTranslation;

// in the main quote route add the provided resolver

import { type Routes } from '@angular/router';
import { resolveQuoteTranslations } from './quote.t';

export const MODULE_ROUTES: Routes = [
  // ...
  {
    // ...
    resolve: {
      resolveQuoteTranslations,
    },
  },
];
```

#### 2b. [OPTIONAL] Configure the translation pipe and/or directive

```typescript
import { Pipe, Directive } from '@angular/core';
import { BaseTranslatePipe, BaseTranslateDirective } from '@mmstack/translate';
import { type QuoteLocale } from './quote.namespace';

@Pipe({
  name: 'translate',
})
export class QuoteTranslatePipe extends BaseTranslatePipe<QuoteLocale> {}

@Directive({
  selector: '[translate]', // input in BaseTranslateDirective is named 'translate'
})
// TInput is necessary to correctly infer the variables to the key
export class QuoteTranslateDirective<TInput extends string> extends BaseTranslateDirective<TInput, QuoteLocale> {}
```

### 3. Have fun :)

```typescript
@Component({
  selector: 'app-quote',
  imports: [QuoteTranslatePipe, QuoteTranslateDirective],
  template: `
    <!-- Pipe validates key & variables match -->
    <h1>{{ 'quote.pageTitle' | translate }}</h1>
    <!-- Non pluralized params must be string -->
    <span>{{ 'quote.errors.minLength' | translate: { min: '5' } }}</span>

    <!-- Directive replaces innerHTML of el -->
    <h1 translate="quote.pageTitle"></h1>
    <span [translate]="['quote.errors.minLength', { min: '5' }]"></span>
  `,
})
export class QuoteComponent {
  protected readonly count = signal(0);
  private readonly t = injectQuoteT();

  private readonly author = this.t('quote.detail.authorLabel'); // static translation

  private readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // must be object with count parameter & type number
  }));
}
```

### 4. [OPTIONAL] - Creating a shared/common namespace

_Note:_ A shared namespace allows you to use it within other `t` functions. You are however responsible for loading it before those `t` functions initialize, usually for a shared namespace that would be at the top route.

#### 4a. Define a shared namespace

Same as quote example, but this time also export the `createMergedNamespace` function. This will be your new factory for other namespaces.

```typescript
// Example: packages/common-locales/src/lib/common.namespace.ts
import { createNamespace } from '@mmstack/translate';

const ns = createNamespace('common', {
  yes: 'Yes',
  no: 'No',
} as const);

// ... rest

export const createAppNamespace = ns.createMergedNamespace;
```

### 4b. Use the common namespace factory instead of the library one

```typescript
// Example: packages/quote/src/lib/quote.namespace.ts
import { createAppNamespace } from '@org/common/locale'; // replace with your library import path

// Create the namespace definition object
const ns = createAppNamespace('quote', {
  pageTitle: 'Famous Quotes',
} as const);

// registration & other stuff remains the same
```

### 4c. Have even more fun!

```typescript
@Component({
  //...
})
export class QuoteComponent {
  private readonly t = injectQuoteT();

  // t function is now 'aware' of the common namespace & its translations
  private readonly yes = this.t('common.yes');

  // quote translations also work the same
  private readonly author = this.t('quote.detail.authorLabel');
}
```

## Contributing

Contributions, issues, and feature requests are welcome!
