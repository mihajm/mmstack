import { type Signal } from '@angular/core';
import { injectLocaleInternal } from '../translation-store';
import { unwrap } from './unwrap';

type ListType = 'conjunction' | 'disjunction' | 'unit';
type ListStyle = 'long' | 'short' | 'narrow';

export type SupportedListInput = string[] | null | undefined;

const cache = new Map<string, Intl.ListFormat>();

/**
 * Options for formatting a list
 */
export type FormatListOptions = {
  /**
   * The type of list to format
   */
  type?: ListType;
  /**
   * The style of list to format
   */
  style?: ListStyle;
  /**
   * Locale to use for formatting, opts out to dynamic locale changes
   */
  locale?: string;
};

const EMPTY_ARRAY: string[] = [];

function unwrapList(
  value: SupportedListInput | Signal<SupportedListInput>,
): string[] {
  const unwrapped = unwrap(value);
  return Array.isArray(unwrapped) ? unwrapped : EMPTY_ARRAY;
}

function getFormatter(
  locale: string,
  type: ListType,
  style: ListStyle,
): Intl.ListFormat {
  const cacheKey = `${locale}|${type}|${style}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.ListFormat(locale, { type, style });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

/**
 * Format a list using the current or provided locale
 * By default it is reactive to the global dynamic locale, works best when wrapped in a computed() if you need to react to locale changes
 *
 * @param value - The list to format
 * @param opt - Options for formatting
 * @returns Formatted list string
 */
export function formatList(
  value: SupportedListInput | Signal<SupportedListInput>,
  opt?: FormatListOptions | Signal<FormatListOptions>,
): string {
  const unwrapped = unwrapList(value);
  if (unwrapped.length === 0) return '';

  const unwrappedOpt = unwrap(opt);
  const loc = unwrappedOpt?.locale ?? injectLocaleInternal()();

  return getFormatter(
    loc,
    unwrappedOpt?.type ?? 'conjunction',
    unwrappedOpt?.style ?? 'long',
  ).format(unwrapped);
}
