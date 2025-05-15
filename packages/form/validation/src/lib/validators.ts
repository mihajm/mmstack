import {
  inject,
  InjectionToken,
  Injector,
  LOCALE_ID,
  Provider,
} from '@angular/core';
import { createArrayValidators } from './array';
import { createBooleanValidators } from './boolean';
import { createDateValidators } from './date';
import { createDateRangeValidators } from './date/date-range';
import { defaultFormatDate, defaultToDate } from './date/util';
import { createFileValidators } from './file';
import { createGeneralValidators } from './general';
import { createMergeValidators } from './merge-validators';
import { createNumberValidators } from './number';
import { createStringValidators } from './string';

type MessageFactories = {
  general: Parameters<typeof createGeneralValidators>[0];
  string: Parameters<typeof createStringValidators>[0];
  number: Parameters<typeof createNumberValidators>[0];
  date: Parameters<typeof createDateValidators>[0];
  array: Parameters<typeof createArrayValidators>[0];
  boolean: Parameters<typeof createBooleanValidators>[0];
  file: Parameters<typeof createFileValidators>[0];
  merge: Parameters<typeof createMergeValidators>[0];
};

/**
 * Represents the consolidated object containing all available validator generators,
 * configured with appropriate localization and date handling for the specified `TDate` type.
 *
 * Obtain this object using `injectValidators()` within an Angular injection context.
 * Use the nested `.all()` methods (e.g., `validators.string.all({...})`) with their
 * corresponding options types (e.g., `StringValidatorOptions`) to create combined
 * validator functions for your form controls.
 *
 * Individual validators (e.g., `validators.general.required()`) are also available.
 *
 * @template TDate The type used for date values (e.g., Date, Luxon DateTime). Defaults to `Date`.
 */
export type Validators<TDate = Date> = {
  general: ReturnType<typeof createGeneralValidators>;
  string: ReturnType<typeof createStringValidators>;
  number: ReturnType<typeof createNumberValidators>;
  date: ReturnType<typeof createDateValidators<TDate>>;
  dateRange: ReturnType<typeof createDateRangeValidators<TDate>>;
  array: ReturnType<typeof createArrayValidators>;
  boolean: ReturnType<typeof createBooleanValidators>;
  file: ReturnType<typeof createFileValidators>;
};

const token = new InjectionToken<Validators>('INTERNAL_MMSTACK_VALIDATORS');

let defaultValidators: Validators | null = null;

function createDefaultValidators<TDate = Date>(): Validators<TDate> {
  if (!defaultValidators) {
    defaultValidators = createValidators<TDate>(
      {},
      defaultToDate,
      defaultFormatDate,
      'en-US',
    ) as Validators;
  }

  return defaultValidators as Validators<TDate>;
}

function createValidators<TDate = Date>(
  msg: Partial<MessageFactories> | void,
  toDate: (date: TDate | string) => Date,
  formatDate: (date: Date, locale: string) => string,
  locale: string,
): Validators<TDate> {
  const general = createGeneralValidators(msg?.general);

  const merger = createMergeValidators(msg?.merge);

  return {
    general,
    string: createStringValidators(msg?.string, general, merger),
    number: createNumberValidators(msg?.number, general, merger),
    date: createDateValidators<TDate>(
      msg?.date,
      toDate,
      formatDate,
      locale,
      general,
      merger,
    ),
    dateRange: createDateRangeValidators<TDate>(
      msg?.date,
      toDate,
      formatDate,
      locale,
      general,
      merger,
    ),
    file: createFileValidators(msg?.file, general, merger),
    array: createArrayValidators(msg?.array, merger),
    boolean: createBooleanValidators(msg?.boolean),
  };
}

/**
 * Provides the configuration for the @mmstack/form-validation system within Angular's DI.
 *
 * Include the returned provider in your application's root providers (e.g., in `app.config.ts`)
 * or relevant feature/route providers to enable localization of validation error messages
 * and configure custom date handling.
 *
 * It automatically uses Angular's `LOCALE_ID` to determine which message factories to apply.
 *
 * @template TDate - The type used for date values throughout your application
 * (e.g., `Date`, Luxon `DateTime`, Moment). Defaults to `Date`. This generic ensures
 * type safety when providing custom `toDate` and `formatDate` functions.
 * @param messageFactoryProvider - A function that receives the current `LOCALE_ID` string
 * (e.g., 'en-US', 'de-DE') and should return an object containing optional custom
 * message factory functions for various validator types (`general`, `string`, `number`, `date`, `array`, `boolean`).
 * Only provide factories for the messages you want to override for that specific locale;
 * defaults will be used for any unspecified factories. Return `undefined` or an empty
 * object to use default messages for the locale.
 * @param toDate - Optional function to convert input values (of type `TDate` or `string`)
 * into standard JavaScript `Date` objects. This is used internally by date validators
 * for comparisons. Defaults to a helper supporting `Date`, `string`, `number`, and
 * common date library objects (Luxon, Moment).
 * **Provide this function if your application uses a date type other than native `Date`**.
 * @param formatDate - Optional function to format a `Date` object into a string suitable
 * for display in date-related error messages (e.g., min/max date errors), respecting
 * the provided `locale`. Defaults to using Angular's `formatDate` with 'mediumDate' format.
 * @returns An Angular `Provider` configuration object to be added to your providers array.
 *
 * @example
 * // In app.config.ts
 * import { ApplicationConfig } from '@angular/core';
 * import { provideValidatorConfig } from '@mmstack/form-validation';
 * // If using a custom date type like Luxon's DateTime
 * // import { DateTime } from 'luxon';
 * // import { defaultToDate } from '@mmstack/form-validation'; // Or your custom util path
 *
 * export const appConfig: ApplicationConfig = {
 * providers: [
 * provideValidatorConfig((locale): Partial<MessageFactories> | void => {
 * console.log('Configuring validators for locale:', locale);
 * if (locale.startsWith('de')) { // Example for German
 * return {
 * general: { required: (label = 'Feld') => `${label} ist erforderlich.` },
 * string: { minLength: (min) => `Mindestens ${min} Zeichen.` }
 * // Only provide overrides needed for this locale
 * };
 * }
 * // Return undefined or {} to use default messages for other locales
 * })
 *
 * // Example if using Luxon DateTime:
 * // provideValidatorConfig<DateTime>(
 * //   (locale) => { ... }, // your message factories
 * //   // Custom toDate function for Luxon
 * //   (d) => (d instanceof DateTime ? d.toJSDate() : defaultToDate(d)),
 * //   // Custom formatDate function for Luxon
 * //   (d, l) => DateTime.fromJSDate(d).setLocale(l).toLocaleString(DateTime.DATE_MED)
 * // )
 * ]
 * };
 */
export function provideValidatorConfig<TDate = Date>(
  factory: (locale: string) => Partial<MessageFactories> | void | undefined,
  toDate: (date: TDate | string) => Date = defaultToDate<TDate>,
  formatDate: (date: Date, locale: string) => string = defaultFormatDate,
): Provider {
  return {
    provide: token,
    useFactory: (locale: string) =>
      createValidators(factory(locale), toDate, formatDate, locale),
    deps: [LOCALE_ID],
  };
}

/**
 * Injects the configured `Validators` object within an Angular injection context.
 *
 * This function is the standard way to access the validation functions
 * (e.g., `validators.string.all`, `validators.number.min`) inside your Angular
 * components, services, directives, or form adapter factories.
 *
 * It ensures that you receive the set of validators configured with the appropriate
 * localization (via `provideValidatorConfig` and `LOCALE_ID`) and custom date handling,
 * if provided.
 *
 * If `provideValidatorConfig` was not used in the current or parent injectors,
 * this function gracefully falls back to a default set of validators using
 * English messages and default date handling (`Date` objects).
 *
 * @template TDate - The type used for date values in your application and configuration
 * (e.g., `Date`, Luxon `DateTime`, Moment). This should match the type argument
 * used in `provideValidatorConfig` if custom date handling was provided. Defaults to `Date`.
 * @param injector - Optional. A specific Angular `Injector` instance to use for resolving
 * the validators. If omitted, it uses the current injection context via `inject()`.
 * @returns The configured `Validators<TDate>` object, ready to use for creating
 * validator functions (e.g., `validators.string.all({ required: true })`).
 *
 * @example
 * // In an Angular component or service:
 * import { Component, inject } from '@angular/core';
 * import { injectValidators } from '@mmstack/form-validation';
 * import { formControl } from '@mmstack/form-core';
 * // Assuming form is configured for native Date objects (or default)
 *
 * @Component({...})
 * export class UserProfileComponent {
 * private validators = injectValidators(); // Inject the validators
 * // Or, if configured for Luxon DateTime:
 * // private validators = injectValidators<DateTime>();
 *
 * // Use the injected validators to define form controls
 * readonly emailControl = formControl('', {
 * label: () => 'Email Address',
 * validator: () => this.validators.string.all({ required: true, email: true })
 * });
 *
 * readonly birthDateControl = formControl<Date | null>(null, {
 * label: () => 'Date of Birth',
 * validator: () => this.validators.date.all({ required: false, max: new Date() })
 * });
 *
 * readonly numberOfPetsControl = formControl<number>(0, {
 * label: () => 'Number of Pets',
 * validator: () => this.validators.number.min(0, 'Pet count') // Using an individual validator
 * });
 * }
 */
export function injectValidators<TDate = Date>(
  injector?: Injector,
): Validators<TDate> {
  const validators = (
    injector
      ? injector.get(token, null, {
          optional: true,
        })
      : inject(token, { optional: true })
  ) as Validators<TDate> | null;

  return validators ?? createDefaultValidators();
}
