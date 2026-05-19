import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
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
   * @default 'conjunction'
   */
  type?: ListType;
  /**
   * The style of list to format
   * @default 'long'
   */
  style?: ListStyle;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatListOptions = Omit<FormatListOptions, 'locale'> & {
  /** Optional locale string falling back to the legacy global signal */
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
 * @example formatList(this.items, this.locale)
 */
export function formatList(
  value: SupportedListInput | Signal<SupportedListInput>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatList(this.items, { locale: 'sl-SI', type: 'disjunction' })
 */
export function formatList(
  value: SupportedListInput | Signal<SupportedListInput>,
  opt: FormatListOptions | Signal<FormatListOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatList()` instead, or pass locale explicitly.
 * @example formatList(this.items)
 */
export function formatList(
  value: SupportedListInput | Signal<SupportedListInput>,
  opt?: UnsafeFormatListOptions | Signal<UnsafeFormatListOptions>,
): string;

export function formatList(
  value: SupportedListInput | Signal<SupportedListInput>,
  optOrLocale?:
    | FormatListOptions
    | Signal<FormatListOptions>
    | string
    | Signal<string>
    | UnsafeFormatListOptions
    | Signal<UnsafeFormatListOptions>,
): string {
  const unwrappedValue = unwrapList(value);
  if (unwrappedValue.length === 0) return '';

  const unwrappedArgs = unwrap(optOrLocale);
  let locale: string;
  let type: ListType = 'conjunction';
  let style: ListStyle = 'long';

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (unwrappedArgs && typeof unwrappedArgs === 'object') {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    type = unwrappedArgs.type ?? 'conjunction';
    style = unwrappedArgs.style ?? 'long';
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(locale, type, style).format(unwrappedValue);
}

const [provideFormatListDefaults, injectFormatListOptions] =
  createFormatterProvider<FormatListOptions>(
    'list',
    {
      type: 'conjunction',
      style: 'long',
    },
    (a, b) => a.type === b.type && a.style === b.style,
  );

/**
 * Provide application-wide defaults for list formatting presets.
 * @example provideFormatListDefaults({ type: 'disjunction' })
 */
export { provideFormatListDefaults };

/**
 * Inject a context-safe list formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 * @example
 * const formatList = injectFormatList();
 * readonly displayList = computed(() => formatList(this.items()));
 */
export function injectFormatList() {
  const defaults = injectFormatListOptions();

  return (
    value: SupportedListInput | Signal<SupportedListInput>,
    optOrLocale?:
      | Partial<FormatListOptions>
      | Signal<Partial<FormatListOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatList(value, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatList(value, opt);
  };
}
