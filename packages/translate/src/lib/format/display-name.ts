import { Signal } from '@angular/core';
import { injectLocaleInternal } from '../translation-store';
import { unwrap } from './unwrap';

const cache = new Map<string, Intl.DisplayNames>();

/**
 * Options for formatting a display name
 */
export type FormatDisplayNameOptions = {
  /**
   * The display style for the result set
   */
  style: Intl.RelativeTimeFormatStyle;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
};

function getFormatter(
  locale: string,
  type: Intl.DisplayNamesType,
  style: Intl.RelativeTimeFormatStyle,
): Intl.DisplayNames {
  const cacheKey = `${locale}|${type}|${style}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.DisplayNames(locale, {
      type,
      style,
    });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

type SupportedCode = string | null | undefined;

/**
 * Format a display name using the current or provided locale
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param value - The code to format
 * @param type - The type of display name to format
 * @param opt - Options for formatting
 * @returns Formatted display name string
 */
export function formatDisplayName(
  value: SupportedCode | Signal<SupportedCode>,
  type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
  opt?: FormatDisplayNameOptions | Signal<FormatDisplayNameOptions>,
): string {
  const unwrapped = unwrap(value);
  if (!unwrapped?.trim()) return '';

  const unwrappedType = unwrap(type);
  const unwrappedOpt = unwrap(opt);

  const locale = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return (
    getFormatter(locale, unwrappedType, unwrappedOpt?.style ?? 'long').of(
      unwrapped,
    ) ?? ''
  );
}
