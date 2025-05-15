# @mmstack/form-validation

Provides a type-safe, composable, and localizable validation system designed specifically for use with [@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core). It enables defining validation rules clearly within your TypeScript code and integrates seamlessly with Angular's Dependency Injection and localization features (`LOCALE_ID`). This library is meant to be used/integrated with other @mmstack form libraries, but it can also be used standalone for any kind of validation purposes.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fform-validation.svg)](https://www.npmjs.com/package/@mmstack/form-validation)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/form/validation/LICENSE)

## Features

- **Type-Safe:** Define validation rules using strongly-typed options objects.
- **Composable:** Easily combine multiple validation rules for a single control.
- **Localizable:** Provide custom, locale-specific error messages via Angular's DI.
- **Custom Date Handling:** Supports custom date object types (e.g., Luxon, Moment) through configuration.
- **Integrated:** Designed to work perfectly with `@mmstack/form-core`'s `formControl`, `formGroup`, and `formArray`.

## Installation

```bash
npm install @mmstack/form-validation
```

## Core Concept: The Validator

At its heart, a validator in this system is a function with the following signature:

```typescript
type Validator<T> = (value: T) => string;
```

- It receives the value to validate (T).
- It returns an empty string ('') if the value is valid.
- It returns a non-empty string (the error message) if the value is invalid.

This library provides functions to easily create and combine these validators.

## Configuration (Optional)

You typically don't need any configuration to get started (it defaults to English messages and native Date handling). However, if you need localized messages or support for custom date objects, use provideValidatorConfig in your application's providers in app.config.ts.

```typescript
// Example: app.config.ts
import { ApplicationConfig, LOCALE_ID } from '@angular/core';
import { provideValidatorConfig } from '@mmstack/form-validation';
// If using a custom date type like Luxon's DateTime
// import { DateTime } from 'luxon';
// import { defaultToDate } from '@mmstack/form-validation'; // Adjust path if needed

export const appConfig: ApplicationConfig = {
  providers: [
    // Provide locale-based validation messages
    provideValidatorConfig((locale) => {
      console.log(`Configuring validation for locale: ${locale}`); // e.g., 'en-US', 'de-DE'

      // Return an object with message factory overrides for the current locale
      if (locale.startsWith('de')) {
        // German example
        return {
          // Override general 'required' message factory
          general: { required: (label) => `${label || 'Feld'} ist erforderlich.` },
          // Override string 'minLength' message factory
          string: { minLength: (min) => `Mindestens ${min} Zeichen.` },
          // Only provide overrides needed; others use defaults
        };
      }
      // Return undefined or {} for other locales to use default messages
    }),

    // Example for custom date type (e.g., Luxon DateTime)
    provideValidatorConfig<DateTime>(
      (locale) => {
        /* messages */
      },
      // Custom toDate: Convert Luxon DateTime (or string) to JS Date for internal comparison
      (d) => (d instanceof DateTime ? d.toJSDate() : defaultToDate(d)),
      // Custom formatDate: Format JS Date back to string using Luxon for error messages
      (d, l) => DateTime.fromJSDate(d).setLocale(l).toLocaleString(DateTime.DATE_MED),
    ),
  ],
};
```

See the JSDoc for provideValidatorConfig for full details on message factories and date handling parameters.

## Usage

If you are using [@mmstack/form-material](https://www.npmjs.com/package/@mmstack/form-material) just use the provided injectCreateXState functions, as it's integrated for you. For standalone usage Inject the configured validator functions into your components, services, or adapter factories using `injectValidators`.

The returned object (`Validators<TDate>`) groups validator generators by type (`general`, `string`, `number`, `date`, `array`, `boolean`). The most common way to use them is via the .all() method available for each type group, which accepts a corresponding Options object (StringValidatorOptions, NumberValidatorOptions, etc.) to combine multiple rules.

```typescript
// Example: my-form.component.ts
import { Component } from '@angular/core';
import { injectValidators, StringValidatorOptions, NumberValidatorOptions, DateValidatorOptions } from '@mmstack/form-validation';
import { formControl } from '@mmstack/form-core';
// Assuming native Date objects are used (default)

@Component({
  selector: 'app-my-form',
  // ... other imports
})
export class MyFormComponent {
  // 1. Inject the configured validators
  private validators = injectValidators();
  // If configured for Luxon: private validators = injectValidators<DateTime>();

  // 2. Define options objects (optional, but good for complex rules)
  readonly nameValidation: StringValidatorOptions = {
    required: true,
    minLength: 2,
    maxLength: 100,
  };

  readonly quantityValidation: NumberValidatorOptions = {
    required: true,
    min: 1,
    integer: true,
  };

  // 3. Use validators when creating form controls
  name = formControl('', {
    label: () => 'Item Name',
    // Use the `.all()` method with the options object
    validator: () => this.validators.string.all(this.nameValidation),
  });

  quantity = formControl<number | null>(null, {
    label: () => 'Quantity',
    // Or define options inline
    validator: () => this.validators.number.all({ required: true, min: 1 }),
  });

  expiryDate = formControl<Date | null>(null, {
    label: () => 'Expiry Date',
    // Example combining general and date-specific rules
    validator: () => this.validators.date.all({ required: false, min: new Date() }),
  });

  // You can also access individual validator generators if needed:
  promoCode = formControl('', {
    label: () => 'Promo Code',
    validator: () => this.validators.string.minLength(5), // Single rule
  });
}
```

## Available Validators (`Options` Types)

Use the following exported `Options` types with the corresponding `.all()` method (e.g., `validators.string.all(options: StringValidatorOptions)`):

- StringValidatorOptions: `required`, `minLength`, `maxLength`, `pattern` (supports RegExp, 'email', 'uri'), `trimmed`, `mustBe`, `not`, `oneOf`, `notOneOf`.
- NumberValidatorOptions: `required`, `min`, `max`, `integer`, `multipleOf`, `mustBe`, `not`, `oneOf`, `notOneOf`.
- DateValidatorOptions: `required`, `min`, `max`, `mustBe`, `not`, `oneOf`, `notOneOf`. (Date comparisons respect the configured `toDate` function).
- ArrayValidatorOptions: `minLength`, `maxLength`. (Note: required for arrays usually means minLength: 1).
- Boolean: Simple validators like `validators.boolean.mustBeTrue()` is available directly (no .all() method needed).
- FileValidatorOptions: `required`, `accepts`, `rejects`, `maxSize`.

Refer to the JSDoc for each Options type for detailed explanations of the properties. The validators.general group provides the base logic for required, mustBe, not, oneOf, notOneOf.

## Localization

As shown in the Configuration section, you can provide locale-specific error message factories using provideValidatorConfig. The library automatically uses the message factories corresponding to the active LOCALE_ID.

## Custom Date Types

f your application uses date objects other than native JavaScript Date (e.g., Luxon DateTime, Moment.js), you must provide custom toDate and formatDate functions via provideValidatorConfig to ensure correct date comparisons and error message formatting. See the Configuration section example and provideValidatorConfig JSDoc.

## Contributing

Contributions, issues, and feature requests are welcome!
