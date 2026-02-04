# @mmstack/translate

**Type-Safe & modular localization for Modern Angular.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Ftranslate.svg)](https://badge.fury.io/js/%40mmstack%2Ftranslate)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

`@mmstack/translate` is an opinionated internationalization (i18n) library for Angular applications built with three core priorities:

1.  **Maximum Type Safety:** Catch errors related to missing keys or incorrect/missing parameters at compile time.
2.  **Flexible Build Process:** Works as a traditional multi-build solution (like `@angular/localize`) **OR** as a single-build runtime solution.
3.  **Scalable Modularity:** Organize translations into **namespaces** (typically aligned with feature libraries) and load them on demand.

It uses the robust **FormatJS** Intl runtime (`@formatjs/intl`) for ICU message formatting, and integrates with Angular's dependency injection and routing.

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

### Comparison

While Angular offers excellent i18n solutions like `@angular/localize` and `transloco`, `@mmstack/translate` aims to fill a specific niche by supporting **both** traditional multi-build and modern single-build approaches.

| Feature                  |         `@mmstack/translate`         |   `@angular/localize`    |          `transloco`          |      `ngx-translate`       |
| :----------------------- | :----------------------------------: | :----------------------: | :---------------------------: | :------------------------: |
| **Build Process**        |       ✅ Single or Multi-Build       | ❌ Multi-Build (Typical) |        ✅ Single Build        |      ✅ Single Build       |
| **Translation Timing**   |        Runtime or Build Time         |       Compile Time       |            Runtime            |          Runtime           |
| **Type Safety (Keys)**   | ✅ Strong (Inferred from structure)  |    🟡 via extraction     |      🟡 Tooling/TS Files      |    🟡 OK Manual/Tooling    |
| **Type Safety (Params)** |    ✅ Strong (Inferred from ICU)     |         ❌ None          |           🟡 Manual           |         🟡 Manual          |
| **Locale Switching**     | ✅ Dynamic (Runtime) or Page refresh | 🔄 Page Refresh Required |     ✅ Dynamic (Runtime)      |    ✅ Dynamic (Runtime)    |
| **Lazy Loading**         |  ✅ Built-in (Namespaces/Resolvers)  |    N/A (Compile Time)    |     ✅ Built-in (Scopes)      |  ✅ Yes (Custom Loaders)   |
| **Namespacing/Scopes**   |             ✅ Built-in              |         ❌ None          |     ✅ Built-in (Scopes)      | 🟡 Manual (File Structure) |
| **ICU Support**          |   ✅ Subset (via FormatJS Runtime)   |  ✅ Yes (Compile Time)   | ✅ Yes (Runtime Intl/Plugins) |     🟡 Via Extensions      |
| **Signal Integration**   |       ✅ Good (`t.asSignal()`)       |           N/A            | ✅ Good (`translateSignal()`) |      ❌ Minimal/None       |
| **Maturity / Community** |                ✨ New                |       Core Angular       |      ✅ Mature / Active       |         ✅ Mature          |

## Installation

Install the library & its peer dependency, `@formatjs/intl`.

```bash
npm install @mmstack/translate @formatjs/intl
```

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

**Optional Configuration:**

```typescript
provideIntlConfig({
  defaultLocale: 'en-US',
  supportedLocales: ['en-US', 'sl-SI', 'de-DE'],

  // Automatically detect and respond to locale route parameter changes, should correspond with actual param name example bellow
  localeParamName: 'locale',

  // Preload default locale for synchronous fallback (rarely needed)
  preloadDefaultLocale: true,
});
```

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
  stats: '{count, plural, =1 {# citat} =2 {# citata} few {# citati} other {# citatov}} na voljo',
});
```

### 2. Register the Namespace & Load Translations

Use `registerNamespace` to prepare your namespace definition and obtain the `injectNamespaceT` function and the `resolveNamespaceTranslation` resolver function.

```typescript
// Example: packages/quote/src/lib/quote.t.ts
import { registerNamespace } from '@mmstack/translate';

const r = registerNamespace(
  // Default locale's compiled translation (functions as fallback)
  () => import('./quote.namespace').then((m) => m.default),
  {
    // Map other locales to promise factories (dynamic imports)
    'sl-SI': () => import('./quote-sl.translation').then((m) => m.default),
    // Add more locales as needed...
  },
);

export const injectQuoteT = r.injectNamespaceT;
export const resolveQuoteTranslations = r.resolveNamespaceTranslation;
```

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
  standalone: true,
})
export class QuoteTranslator extends Translator<QuoteLocale> {}

@Directive({
  selector: '[translate]', // Input in Translate is named 'translate'
  standalone: true,
})
export class QuoteTranslate<TInput extends string> extends Translate<TInput, QuoteLocale> {}
```

### 3. Use Translations in Components

```typescript
import { Component, signal } from '@angular/core';
import { injectQuoteT } from './quote.t';
import { QuoteTranslator, QuoteTranslate } from './quote.helpers';

@Component({
  selector: 'app-quote',
  standalone: true,
  imports: [QuoteTranslator, QuoteTranslate],
  template: `
    <!-- Pipe validates key & variables match -->
    <h1>{{ 'quote.pageTitle' | translate }}</h1>
    <!-- Non-pluralized params must be string -->
    <span>{{ 'quote.errors.minLength' | translate: { min: '5' } }}</span>

    <!-- Directive replaces textContent of element -->
    <h1 translate="quote.pageTitle"></h1>
    <span [translate]="['quote.errors.minLength', { min: '5' }]"></span>
  `,
})
export class QuoteComponent {
  protected readonly count = signal(0);
  private readonly t = injectQuoteT();

  // Static translation
  private readonly author = this.t('quote.detail.authorLabel');

  // Reactive translation with signal parameters
  private readonly stats = this.t.asSignal('quote.stats', () => ({
    count: this.count(), // Must match ICU parameter (type: number)
  }));
}
```

### 4. [OPTIONAL] Route-Based Locale Detection

For applications with locale-based routing (e.g., `/en-US/quotes`, `/sl-SI/quotes`), the library can automatically detect and switch locales.

**Step 1: Configure locale parameter name**

```typescript
// app.config.ts
import { provideIntlConfig } from '@mmstack/translate';

export const appConfig: ApplicationConfig = {
  providers: [
    provideIntlConfig({
      defaultLocale: 'en-US',
      supportedLocales: ['en-US', 'sl-SI', 'de-DE'],
      localeParamName: 'locale', // Track this route parameter automatically
    }),
  ],
};
```

**Step 2: Add route guard for validation**

```typescript
// app.routes.ts
import { Routes } from '@angular/router';
import { canMatchLocale } from '@mmstack/translate';

export const routes: Routes = [
  {
    path: ':locale',
    canMatch: [canMatchLocale()], // Validates & redirects invalid locales
    children: [
      {
        path: 'quotes',
        loadChildren: () => import('./quote/quote.routes').then((m) => m.QUOTE_ROUTES),
      },
      // ... other routes
    ],
  },
];
```

**That's it!** The library will:

- Detect locale changes from route parameters
- Load translations on demand for the new locale
- Update all translation outputs reactively
- Redirect invalid locales to the default

**With prefix segments:**

If your locale parameter isn't the first segment (e.g., `/app/:locale/...`):

```typescript
{
  path: 'app/:locale',
  canMatch: [canMatchLocale(['app'])], // Validates second segment
  children: [...]
}
```

### 5. [OPTIONAL] Dynamic Language Switching

For applications that need runtime language switching without page refreshes (e.g., language selector in header), use `injectDynamicLocale()`:

```typescript
import { Component } from '@angular/core';
import { injectDynamicLocale } from '@mmstack/translate';

@Component({
  selector: 'app-language-switcher',
  template: `
    <select [value]="locale()" (change)="changeLanguage($event)">
      <option value="en-US">English</option>
      <option value="sl-SI">Slovenščina</option>
      <option value="de-DE">Deutsch</option>
    </select>

    @if (locale.isLoading()) {
      <div class="spinner">Loading translations...</div>
    }
  `,
})
export class LanguageSwitcherComponent {
  protected readonly locale = injectDynamicLocale();

  changeLanguage(event: Event) {
    const target = event.target as HTMLSelectElement;
    this.locale.set(target.value); // Automatically loads missing translations
  }
}
```

**Features:**

- Validates against `supportedLocales` (if configured)
- Automatically loads missing namespace translations
- Provides `isLoading()` signal for UI feedback
- Works with route-based locales

**Important Note for Pure Pipes:**

Due to Angular's memoization, pure pipes don't automatically react to locale changes. Solutions:

```typescript
// Option 1: Pass locale as parameter (recommended)
{{ 'common.yes' | translate : locale() }}

// Option 2: Make pipe impure (not recommended for performance)
@Pipe({
  name: 'translate',
  pure: false,
})
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

const r = registerNamespace(() => import('./common.namespace').then((m) => m.default), {
  'sl-SI': () => import('./common-sl.translation').then((m) => m.default),
});

export const injectCommonT = r.injectNamespaceT;
export const resolveCommonTranslations = r.resolveNamespaceTranslation;
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
- Cancellation support via `AbortSignal`
- Better error handling

### On-Demand Translation Loading

When switching locales dynamically, the library:

1. Checks which namespaces need translations for the new locale
2. Loads only the missing translations in parallel
3. Updates all reactive outputs automatically
4. Falls back to the default locale if unavailable

## Migration from Other Libraries

### From @angular/localize

`@mmstack/translate` can work exactly like `@angular/localize` by default - no migration needed for the build process! Simply:

1. Define your translations using `createNamespace`
2. Register namespaces with resolvers
3. Use the translation functions/pipes/directives

The main difference is the namespace organization and type safety.

### From transloco/ngx-translate

If you're migrating from a runtime-only solution:

1. Configure `provideIntlConfig()` with your supported locales
2. Use `localeParamName` if you have route-based locales
3. Use `injectDynamicLocale()` for programmatic locale switching
4. Convert your translation JSON files to TypeScript using `createNamespace`
5. Update component/template usage to use the type-safe APIs

## Contributing

Contributions, issues, and feature requests are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT © [Mihael Mulec](https://github.com/mihajm)
