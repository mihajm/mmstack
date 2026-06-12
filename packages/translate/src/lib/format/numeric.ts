import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
import { mergeDefined, unwrap } from './unwrap';

type NumberNotation = 'standard' | 'scientific' | 'engineering' | 'compact';

/** How to display the sign — mirrors `Intl.NumberFormatOptions['signDisplay']`. */
export type NumberSignDisplay =
  | 'auto'
  | 'never'
  | 'always'
  | 'exceptZero'
  | 'negative';

/** Rounding behavior — mirrors the ES2023 `Intl.NumberFormatOptions['roundingMode']`. */
export type NumberRoundingMode =
  | 'ceil'
  | 'floor'
  | 'expand'
  | 'trunc'
  | 'halfCeil'
  | 'halfFloor'
  | 'halfExpand'
  | 'halfTrunc'
  | 'halfEven';

/** How to display a unit — mirrors `Intl.NumberFormatOptions['unitDisplay']`. */
export type NumberUnitDisplay = 'short' | 'narrow' | 'long';

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
   * How to display the sign (e.g. `'exceptZero'` renders "+5", "-5", "0").
   * @default 'auto'
   */
  signDisplay?: NumberSignDisplay;
  /**
   * Rounding behavior when truncating fraction digits (ES2023 Intl).
   * @default 'halfExpand'
   */
  roundingMode?: NumberRoundingMode;
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

type NumericFormatterConfig = {
  minFractionDigits?: number;
  maxFractionDigits?: number;
  useGrouping?: boolean;
  notation?: NumberNotation;
  currency?: string;
  display?: CurrencyDisplay;
  style?: 'currency' | 'percent' | 'unit';
  signDisplay?: NumberSignDisplay;
  roundingMode?: NumberRoundingMode;
  unit?: string;
  unitDisplay?: NumberUnitDisplay;
};

function getFormatter(
  locale: string,
  cfg: NumericFormatterConfig,
): Intl.NumberFormat {
  const cacheKey = `${locale}|${cfg.style ?? 'decimal'}|${cfg.notation ?? 'standard'}|${cfg.minFractionDigits}|${cfg.maxFractionDigits}|${cfg.useGrouping}|${cfg.currency ?? 'none'}|${cfg.display ?? 'none'}|${cfg.signDisplay ?? 'auto'}|${cfg.roundingMode ?? 'halfExpand'}|${cfg.unit ?? 'none'}|${cfg.unitDisplay ?? 'short'}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: cfg.style,
      notation: cfg.notation,
      minimumFractionDigits: cfg.minFractionDigits,
      maximumFractionDigits: cfg.maxFractionDigits,
      useGrouping: cfg.useGrouping,
      currency: cfg.currency,
      currencyDisplay: cfg.display,
      signDisplay: cfg.signDisplay,
      unit: cfg.unit,
      unitDisplay: cfg.unitDisplay,
      // roundingMode is ES2023 — may be missing from older lib typings, runtime-safe
      ...({ roundingMode: cfg.roundingMode } as Intl.NumberFormatOptions),
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
  let signDisplay: NumberSignDisplay | undefined;
  let roundingMode: NumberRoundingMode | undefined;

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (isOpt) {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    notation = unwrappedArgs.notation ?? 'standard';
    minFractionDigits = unwrappedArgs.minFractionDigits;
    maxFractionDigits = unwrappedArgs.maxFractionDigits;
    useGrouping = unwrappedArgs.useGrouping ?? true;
    signDisplay = unwrappedArgs.signDisplay;
    roundingMode = unwrappedArgs.roundingMode;
  } else {
    locale = readLocaleUnsafe();
    notation = 'standard';
  }

  return getFormatter(locale, {
    minFractionDigits,
    maxFractionDigits,
    useGrouping,
    notation,
    signDisplay,
    roundingMode,
  }).format(unwrappedNumber);
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
      a.signDisplay === b.signDisplay &&
      a.roundingMode === b.roundingMode &&
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
        ? mergeDefined(defaults(), unwrapped)
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

  return getFormatter(locale, {
    minFractionDigits,
    maxFractionDigits,
    style: 'percent',
  }).format(unwrappedNumber);
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
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes.
 *
 * @example
 * ```ts
 * const formatPercent = injectFormatPercent();
 * readonly progressLabel = computed(() => formatPercent(this.progress() / 100));
 * ```
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
        ? mergeDefined(defaults(), unwrapped)
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
   * Minimum number of fraction digits to use (overrides the currency's default).
   */
  minFractionDigits?: number;
  /**
   * Maximum number of fraction digits to use (overrides the currency's default,
   * e.g. `0` renders "$1,235" for whole-dollar displays).
   */
  maxFractionDigits?: number;
  /**
   * How to display the sign (e.g. `'exceptZero'` renders "+$5.00").
   * @default 'auto'
   */
  signDisplay?: NumberSignDisplay;
  /**
   * Rounding behavior when truncating fraction digits (ES2023 Intl).
   * @default 'halfExpand'
   */
  roundingMode?: NumberRoundingMode;
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
  let minFractionDigits: number | undefined;
  let maxFractionDigits: number | undefined;
  let signDisplay: NumberSignDisplay | undefined;
  let roundingMode: NumberRoundingMode | undefined;

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (isOpt) {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    display = unwrappedArgs.display ?? 'symbol';
    minFractionDigits = unwrappedArgs.minFractionDigits;
    maxFractionDigits = unwrappedArgs.maxFractionDigits;
    signDisplay = unwrappedArgs.signDisplay;
    roundingMode = unwrappedArgs.roundingMode;
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(locale, {
    minFractionDigits,
    maxFractionDigits,
    currency: unwrap(currency),
    display,
    style: 'currency',
    signDisplay,
    roundingMode,
  }).format(unwrappedValue);
}

const [provideFormatCurrencyDefaults, injectFormatCurrencyOptions] =
  createFormatterProvider<FormatCurrencyOptions>(
    'currency',
    {
      display: 'symbol',
    },
    (a, b) =>
      a.display === b.display &&
      a.minFractionDigits === b.minFractionDigits &&
      a.maxFractionDigits === b.maxFractionDigits &&
      a.signDisplay === b.signDisplay &&
      a.roundingMode === b.roundingMode &&
      a.fallbackToZero === b.fallbackToZero,
  );

/**
 * Provide application-wide defaults for currency formatting presets.
 * @example provideFormatCurrencyDefaults({ display: 'code' })
 */
export { provideFormatCurrencyDefaults };

/**
 * Inject a context-safe currency formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes.
 *
 * @example
 * ```ts
 * const formatCurrency = injectFormatCurrency();
 * readonly priceLabel = computed(() => formatCurrency(this.price(), 'USD'));
 * ```
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
        ? mergeDefined(defaults(), unwrapped)
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatCurrency(value, currency, opt);
  };
}

/**
 * Options for formatting a measurement unit
 */
export type FormatUnitOptions = {
  /**
   * How the unit is rendered: `'short'` ("16 km/h"), `'narrow'` ("16km/h"),
   * `'long'` ("16 kilometers per hour").
   * @default 'short'
   */
  unitDisplay?: NumberUnitDisplay;
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
   * How to display the sign.
   * @default 'auto'
   */
  signDisplay?: NumberSignDisplay;
  /**
   * Rounding behavior when truncating fraction digits (ES2023 Intl).
   * @default 'halfExpand'
   */
  roundingMode?: NumberRoundingMode;
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
 * Formats a number with a measurement unit via `Intl.NumberFormat`'s `unit` style.
 * Accepts any [ECMA-402 sanctioned unit](https://tc39.es/ecma402/#table-sanctioned-single-unit-identifiers)
 * or a `-per-` compound (e.g. `'kilometer-per-hour'`).
 *
 * @example
 * formatUnit(16, 'kilometer-per-hour', 'en-US'); // "16 km/h"
 * formatUnit(2.5, 'liter', { locale: 'de-DE', unitDisplay: 'long' }); // "2,5 Liter"
 */
export function formatUnit(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  unit: string | Signal<string>,
  optOrLocale:
    | FormatUnitOptions
    | Signal<FormatUnitOptions>
    | string
    | Signal<string>,
): string {
  const unwrappedArgs = unwrap(optOrLocale);
  const isOpt = typeof unwrappedArgs === 'object';
  const fallbackToZero = isOpt ? unwrappedArgs.fallbackToZero : undefined;
  const unwrappedValue = unwrapValue(value, fallbackToZero);

  if (unwrappedValue === null) return '';

  const locale = isOpt ? unwrappedArgs.locale : unwrappedArgs;
  const opt = isOpt ? unwrappedArgs : undefined;

  return getFormatter(locale, {
    minFractionDigits: opt?.minFractionDigits,
    maxFractionDigits: opt?.maxFractionDigits,
    useGrouping: opt?.useGrouping ?? true,
    unit: unwrap(unit),
    unitDisplay: opt?.unitDisplay ?? 'short',
    style: 'unit',
    signDisplay: opt?.signDisplay,
    roundingMode: opt?.roundingMode,
  }).format(unwrappedValue);
}

const [provideFormatUnitDefaults, injectFormatUnitOptions] =
  createFormatterProvider<FormatUnitOptions>(
    'unit',
    {
      unitDisplay: 'short',
      useGrouping: true,
    },
    (a, b) =>
      a.unitDisplay === b.unitDisplay &&
      a.minFractionDigits === b.minFractionDigits &&
      a.maxFractionDigits === b.maxFractionDigits &&
      a.useGrouping === b.useGrouping &&
      a.signDisplay === b.signDisplay &&
      a.roundingMode === b.roundingMode &&
      a.fallbackToZero === b.fallbackToZero,
  );

/**
 * Provide application-wide defaults for unit formatting presets.
 * @example provideFormatUnitDefaults({ unitDisplay: 'long' })
 */
export { provideFormatUnitDefaults };

/**
 * Inject a context-safe unit formatting function tied to the current injector.
 * Uses the library's locale signal & provided default configuration to react to locale/config changes.
 *
 * @example
 * ```ts
 * const formatUnit = injectFormatUnit();
 * readonly speedLabel = computed(() => formatUnit(this.speed(), 'kilometer-per-hour'));
 * ```
 */
export function injectFormatUnit() {
  const defaults = injectFormatUnitOptions();

  return (
    value: SupportedNumberValue | Signal<SupportedNumberValue>,
    unit: string | Signal<string>,
    optOrLocale?:
      | Partial<FormatUnitOptions>
      | Signal<Partial<FormatUnitOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatUnit(value, unit, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? mergeDefined(defaults(), unwrapped)
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatUnit(value, unit, opt);
  };
}
