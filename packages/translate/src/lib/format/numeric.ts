import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
import { unwrap } from './unwrap';

type NumberNotation = 'standard' | 'scientific' | 'engineering' | 'compact';

type SupportedNumberValue = number | null | undefined;

const cache = new Map<string, Intl.NumberFormat>();

function unwrapValue(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  fallbackToZero = false,
): number | null {
  const unwrapped = unwrap(value);

  if (unwrapped === null || unwrapped === undefined || isNaN(unwrapped))
    return fallbackToZero ? 0 : null;

  return unwrapped;
}

/**
 * Options for formatting a number
 */
export type FormatNumberOptions = {
  /**
   * The notation to use for formatting
   * @default 'standard'
   */
  notation?: NumberNotation;
  /**
   * Minimum number of fraction digits to use
   */
  minFractionDigits?: number;
  /**
   * Maximum number of fraction digits to use
   */
  maxFractionDigits?: number;
  /**
   * Whether to use grouping
   * @default true
   */
  useGrouping?: boolean;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatNumberOptions = Omit<FormatNumberOptions, 'locale'> & {
  /** Optional locale string falling back to the legacy global signal */
  locale?: string;
};

function getFormatter(
  locale: string,
  minFractionDigits: number | undefined,
  maxFractionDigits: number | undefined,
  useGrouping?: boolean,
  notation?: NumberNotation,
  currency?: string,
  display?: CurrencyDisplay,
  style?: 'currency' | 'percent',
): Intl.NumberFormat {
  const cacheKey = `${locale}|${notation ?? 'standard'}|${minFractionDigits}|${maxFractionDigits}|${useGrouping ?? true}|${currency ?? 'none'}|${display ?? 'none'}|${style ?? 'decimal'}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style,
      notation,
      minimumFractionDigits: minFractionDigits,
      maximumFractionDigits: maxFractionDigits,
      useGrouping,
      currency,
      currencyDisplay: display,
    });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

/**
 * @example formatNumber(this.value, this.locale)
 */
export function formatNumber(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatNumber(this.value, { locale: 'de-DE', notation: 'compact' })
 */
export function formatNumber(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt: FormatNumberOptions | Signal<FormatNumberOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatNumber()` instead, or pass locale explicitly.
 * @example formatNumber(this.value)
 */
export function formatNumber(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt?: UnsafeFormatNumberOptions | Signal<UnsafeFormatNumberOptions>,
): string;

export function formatNumber(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  optOrLocale?:
    | FormatNumberOptions
    | Signal<FormatNumberOptions>
    | string
    | Signal<string>
    | UnsafeFormatNumberOptions
    | Signal<UnsafeFormatNumberOptions>,
): string {
  const unwrappedArgs = unwrap(optOrLocale);
  const isOpt = unwrappedArgs != null && typeof unwrappedArgs === 'object';
  const fallbackToZero = isOpt ? unwrappedArgs.fallbackToZero : undefined;
  const unwrappedNumber = unwrapValue(value, fallbackToZero);

  if (unwrappedNumber === null) return '';

  let locale: string;
  let notation: NumberNotation | undefined;
  let minFractionDigits: number | undefined;
  let maxFractionDigits: number | undefined;
  let useGrouping = true;

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (isOpt) {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    notation = unwrappedArgs.notation ?? 'standard';
    minFractionDigits = unwrappedArgs.minFractionDigits;
    maxFractionDigits = unwrappedArgs.maxFractionDigits;
    useGrouping = unwrappedArgs.useGrouping ?? true;
  } else {
    locale = readLocaleUnsafe();
    notation = 'standard';
  }

  return getFormatter(
    locale,
    minFractionDigits,
    maxFractionDigits,
    useGrouping,
    notation,
  ).format(unwrappedNumber);
}

const [provideFormatNumberDefaults, injectFormatNumberOptions] =
  createFormatterProvider<FormatNumberOptions>(
    'number',
    {
      notation: 'standard',
      useGrouping: true,
    },
    (a, b) =>
      a.notation === b.notation &&
      a.minFractionDigits === b.minFractionDigits &&
      a.maxFractionDigits === b.maxFractionDigits &&
      a.useGrouping === b.useGrouping &&
      a.fallbackToZero === b.fallbackToZero,
  );

/**
 * Provide application-wide defaults for number formatting presets.
 * @example provideFormatNumberDefaults({ notation: 'compact' })
 */
export { provideFormatNumberDefaults };

/**
 * Inject a context-safe number formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 * @example
 * const formatNumber = injectFormatNumber();
 * readonly display = computed(() => formatNumber(this.value()));
 */
export function injectFormatNumber() {
  const defaults = injectFormatNumberOptions();

  return (
    value: SupportedNumberValue | Signal<SupportedNumberValue>,
    optOrLocale?:
      | Partial<FormatNumberOptions>
      | Signal<Partial<FormatNumberOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatNumber(value, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatNumber(value, opt);
  };
}

/**
 * Options for formatting a percentage value
 */
export type FormatPercentOptions = {
  /**
   * Minimum number of fraction digits to use
   */
  minFractionDigits?: number;
  /**
   * Maximum number of fraction digits to use
   */
  maxFractionDigits?: number;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatPercentOptions = Omit<
  FormatPercentOptions,
  'locale'
> & {
  /** Optional locale string falling back to the legacy global signal */
  locale?: string;
};

/**
 * @example formatPercent(this.value, this.locale)
 */
export function formatPercent(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatPercent(this.value, { locale: 'de-DE', maxFractionDigits: 2 })
 */
export function formatPercent(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt: FormatPercentOptions | Signal<FormatPercentOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatPercent()` instead, or pass locale explicitly.
 * @example formatPercent(this.value)
 */
export function formatPercent(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt?: UnsafeFormatPercentOptions | Signal<UnsafeFormatPercentOptions>,
): string;

export function formatPercent(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  optOrLocale?:
    | FormatPercentOptions
    | Signal<FormatPercentOptions>
    | string
    | Signal<string>
    | UnsafeFormatPercentOptions
    | Signal<UnsafeFormatPercentOptions>,
): string {
  const unwrappedArgs = unwrap(optOrLocale);
  const isOpt = unwrappedArgs != null && typeof unwrappedArgs === 'object';
  const fallbackToZero = isOpt ? unwrappedArgs.fallbackToZero : undefined;
  const unwrappedNumber = unwrapValue(value, fallbackToZero);

  if (unwrappedNumber === null) return '';

  let locale: string;
  let minFractionDigits: number | undefined;
  let maxFractionDigits: number | undefined;

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (isOpt) {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    minFractionDigits = unwrappedArgs.minFractionDigits;
    maxFractionDigits = unwrappedArgs.maxFractionDigits;
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(
    locale,
    minFractionDigits,
    maxFractionDigits,
    undefined,
    undefined,
    undefined,
    undefined,
    'percent',
  ).format(unwrappedNumber);
}

const [provideFormatPercentDefaults, injectFormatPercentOptions] =
  createFormatterProvider<FormatPercentOptions>(
    'percent',
    {},
    (a, b) =>
      a.minFractionDigits === b.minFractionDigits &&
      a.maxFractionDigits === b.maxFractionDigits &&
      a.fallbackToZero === b.fallbackToZero,
  );

/**
 * Provide application-wide defaults for percent formatting presets.
 * @example provideFormatPercentDefaults({ maxFractionDigits: 1 })
 */
export { provideFormatPercentDefaults };

/**
 * Inject a context-safe percent formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 */
export function injectFormatPercent() {
  const defaults = injectFormatPercentOptions();

  return (
    value: SupportedNumberValue | Signal<SupportedNumberValue>,
    optOrLocale?:
      | Partial<FormatPercentOptions>
      | Signal<Partial<FormatPercentOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatPercent(value, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatPercent(value, opt);
  };
}

type CurrencyDisplay = 'symbol' | 'narrowSymbol' | 'code' | 'name';

/**
 * Options for formatting a currency
 */
export type FormatCurrencyOptions = {
  /**
   * The display type for the currency format
   * @default 'symbol'
   */
  display?: CurrencyDisplay;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatCurrencyOptions = Omit<
  FormatCurrencyOptions,
  'locale'
> & {
  /** Optional locale string falling back to the legacy global signal */
  locale?: string;
};

/**
 * @example formatCurrency(this.value, 'USD', this.locale)
 */
export function formatCurrency(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  currency: string | Signal<string>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatCurrency(this.value, 'EUR', { locale: 'de-DE', display: 'code' })
 */
export function formatCurrency(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  currency: string | Signal<string>,
  opt: FormatCurrencyOptions | Signal<FormatCurrencyOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatCurrency()` instead, or pass locale explicitly.
 * @example formatCurrency(this.value, 'USD')
 */
export function formatCurrency(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  currency: string | Signal<string>,
  opt?: UnsafeFormatCurrencyOptions | Signal<UnsafeFormatCurrencyOptions>,
): string;

export function formatCurrency(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  currency: string | Signal<string>,
  optOrLocale?:
    | FormatCurrencyOptions
    | Signal<FormatCurrencyOptions>
    | string
    | Signal<string>
    | UnsafeFormatCurrencyOptions
    | Signal<UnsafeFormatCurrencyOptions>,
): string {
  const unwrappedArgs = unwrap(optOrLocale);
  const isOpt = unwrappedArgs != null && typeof unwrappedArgs === 'object';
  const fallbackToZero = isOpt ? unwrappedArgs.fallbackToZero : undefined;
  const unwrappedValue = unwrapValue(value, fallbackToZero);

  if (unwrappedValue === null) return '';

  let locale: string;
  let display: CurrencyDisplay = 'symbol';

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (isOpt) {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    display = unwrappedArgs.display ?? 'symbol';
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(
    locale,
    undefined,
    undefined,
    undefined,
    undefined,
    unwrap(currency),
    display,
    'currency',
  ).format(unwrappedValue);
}

const [provideFormatCurrencyDefaults, injectFormatCurrencyOptions] =
  createFormatterProvider<FormatCurrencyOptions>(
    'currency',
    {
      display: 'symbol',
    },
    (a, b) =>
      a.display === b.display && a.fallbackToZero === b.fallbackToZero,
  );

/**
 * Provide application-wide defaults for currency formatting presets.
 * @example provideFormatCurrencyDefaults({ display: 'code' })
 */
export { provideFormatCurrencyDefaults };

/**
 * Inject a context-safe currency formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 */
export function injectFormatCurrency() {
  const defaults = injectFormatCurrencyOptions();

  return (
    value: SupportedNumberValue | Signal<SupportedNumberValue>,
    currency: string | Signal<string>,
    optOrLocale?:
      | Partial<FormatCurrencyOptions>
      | Signal<Partial<FormatCurrencyOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatCurrency(value, currency, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatCurrency(value, currency, opt);
  };
}
