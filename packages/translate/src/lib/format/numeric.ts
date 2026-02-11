import { type Signal } from '@angular/core';
import { injectLocaleInternal } from '../translation-store';
import { unwrap } from './unwrap';

type NumberNotation = 'standard' | 'scientific' | 'engineering' | 'compact';

type SupportedNumberValue = number | null | undefined;

const cache = new Map<string, Intl.NumberFormat>();

function unwrapValue(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  fallbackToZero: boolean = false,
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
   */
  useGrouping?: boolean;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
};

function getFormatter(
  locale: string,
  minFractionDigits: number,
  maxFractionDigits: number,
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
    });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

/**
 * Format a number using the current or provided locale
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param number - Number to format
 * @param opt - Options for formatting
 * @returns Formatted number string
 */
export function formatNumber(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt?: FormatNumberOptions | Signal<FormatNumberOptions>,
): string {
  const unwrappedOpt = unwrap(opt);
  const unwrappedNumber = unwrapValue(value, unwrappedOpt?.fallbackToZero);

  if (unwrappedNumber === null) return '';

  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    unwrappedOpt?.minFractionDigits ?? 0,
    unwrappedOpt?.maxFractionDigits ?? 0,
    unwrappedOpt?.useGrouping ?? true,
    unwrappedOpt?.notation ?? 'standard',
  ).format(unwrappedNumber);
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
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
};

/**
 * Format a percentage using the current or provided locale
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param number - Number to format
 * @param opt - Options for formatting
 * @returns Formatted percentage string
 */
export function formatPercent(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  opt?: FormatPercentOptions | Signal<FormatPercentOptions>,
): string {
  const unwrappedOpt = unwrap(opt);

  let unwrappedNumber = unwrapValue(value, unwrappedOpt?.fallbackToZero);

  if (unwrappedNumber === null) return '';

  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    unwrappedOpt?.minFractionDigits ?? 0,
    unwrappedOpt?.maxFractionDigits ?? 0,
    undefined,
    undefined,
    undefined,
    undefined,
    'percent',
  ).format(unwrappedNumber);
}

type CurrencyDisplay = 'symbol' | 'narrowSymbol' | 'code' | 'name';

/**
 * Options for formatting a currency
 */
export type FormatCurrencyOptions = {
  /*
   * The display type for the currency format
   */
  display?: CurrencyDisplay;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
  /**
   * If the number is not a valid number, return formatted 0. By default formatter returns an empty string
   * @default false
   */
  fallbackToZero?: boolean;
};

export function formatCurrency(
  value: SupportedNumberValue | Signal<SupportedNumberValue>,
  currency: string | Signal<string>,
  opt?: FormatCurrencyOptions | Signal<FormatCurrencyOptions>,
): string {
  const unwrappedOpt = unwrap(opt);
  const unwrappedValue = unwrapValue(value, unwrappedOpt?.fallbackToZero);

  if (unwrappedValue === null) return '';

  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    0,
    0,
    undefined,
    undefined,
    unwrap(currency),
    unwrappedOpt?.display ?? 'symbol',
    'currency',
  ).format(unwrappedValue);
}
