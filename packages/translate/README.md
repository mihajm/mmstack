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
- 🌍 **ICU Message Syntax:** Uses FormatJS runtime for robust support of variables (`{name}`), `plural`, `select`, and `selectordinal`. (Note: Complex inline date/number formats are not the focus; use Angular's built in Pipes/format functions & ues the result as variables in your translation.)
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

_Note:_ To provide flexibility `@mmstack/translate` does not provide a mechanism to set `LOCALE_ID`. So you'll have to provide the mechanism which sets it. For example:

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

## Usage
