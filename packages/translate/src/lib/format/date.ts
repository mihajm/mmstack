import { type Signal } from '@angular/core';
import { injectLocaleInternal } from '../translation-store';
import { unwrap } from './unwrap';

const FORMAT_PRESETS: Record<string, Intl.DateTimeFormatOptions> = {
  short: { dateStyle: 'short', timeStyle: 'short' },
  medium: { dateStyle: 'medium', timeStyle: 'medium' },
  long: { dateStyle: 'long', timeStyle: 'long' },
  full: { dateStyle: 'full', timeStyle: 'full' },

  shortDate: { dateStyle: 'short' },
  mediumDate: { dateStyle: 'medium' },
  longDate: { dateStyle: 'long' },
  fullDate: { dateStyle: 'full' },

  shortTime: { timeStyle: 'short' },
  mediumTime: { timeStyle: 'medium' },
  longTime: { timeStyle: 'long' },
  fullTime: { timeStyle: 'full' },
};

type DateFormat = keyof typeof FORMAT_PRESETS;

/**
 * Supported date inputs
 */
export type SupportedDateInput = Date | string | number | null | undefined;

/**
 * Options for formatting a date
 */
export type FormatDateOptions = {
  /**
   * Timezone to use for formatting
   */
  tz?: string;
  /**
   * Format to use for formatting
   * @default 'medium'
   */
  format?: DateFormat;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
};

function validDateOrNull(
  date: Date | string | number | null | undefined,
): Date | null {
  if (date == null) return null;

  const d = date instanceof Date ? date : new Date(date);
  return isNaN(d.getTime()) ? null : d;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  locale: string,
  format: DateFormat,
  timeZone?: string,
): Intl.DateTimeFormat {
  const cacheKey = `${locale}|${format}|${timeZone ?? ''}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      ...FORMAT_PRESETS[format],
      timeZone,
    });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

/**
 * Format a date using the current or provided locale & timezone
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param date - Date to format
 * @param opt - Options for formatting
 * @returns Formatted date string
 */
export function formatDate(
  date: SupportedDateInput | Signal<SupportedDateInput>,
  opt?: FormatDateOptions | Signal<FormatDateOptions>,
): string {
  const validDate = validDateOrNull(unwrap(date));
  if (validDate === null) return '';

  const unwrappedOpt = unwrap(opt);
  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    unwrappedOpt?.format ?? 'medium',
    unwrappedOpt?.tz,
  ).format(validDate);
}
