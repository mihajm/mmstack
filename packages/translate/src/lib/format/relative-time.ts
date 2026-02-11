import { type Signal } from '@angular/core';
import { injectLocaleInternal } from '../translation-store';
import { unwrap } from './unwrap';

const cache = new Map<string, Intl.RelativeTimeFormat>();

/**
 * Options for formatting a relative time value
 */
export type FormatRelativeTimeOptions = {
  /**
   * The length of the internationalized message.
   * @default 'long'
   */
  style?: Intl.RelativeTimeFormatStyle;
  /**
   * Controls whether to use numeric values in the output.
   * @default 'always'
   */
  numeric?: Intl.RelativeTimeFormatNumeric;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
};

function getFormatter(
  locale: string,
  style: Intl.RelativeTimeFormatStyle,
  numeric: Intl.RelativeTimeFormatNumeric,
): Intl.RelativeTimeFormat {
  const cacheKey = `${locale}|${style}|${numeric}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { style, numeric });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

export type RelativeTimeUnit = Intl.RelativeTimeFormatUnit;

type SupportedRelativeTimeInput = number | null | undefined;

/**
 * Format a relative time using the current or provided locale
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param value - The numeric value to use in the relative time internationalization message
 * @param unit - The unit to use in the relative time internationalization message
 * @param opt - Options for formatting
 * @returns Formatted relative time string
 */
export function formatRelativeTime(
  value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
  unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
  opt?: FormatRelativeTimeOptions | Signal<FormatRelativeTimeOptions>,
): string {
  const unwrappedValue = unwrap(value);
  if (
    unwrappedValue === null ||
    unwrappedValue === undefined ||
    isNaN(unwrappedValue)
  )
    return '';

  const unwrappedUnit = unwrap(unit);
  if (!unwrappedUnit) return '';

  const unwrappedOpt = unwrap(opt);
  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    unwrappedOpt?.style ?? 'long',
    unwrappedOpt?.numeric ?? 'always',
  ).format(unwrappedValue, unwrappedUnit);
}
