import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
import { unwrap } from './unwrap';

const FORMAT_PRESETS = {
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
} satisfies Record<string, Intl.DateTimeFormatOptions>;

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
  format?: DateFormat | Intl.DateTimeFormatOptions;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatDateOptions = Omit<FormatDateOptions, 'locale'> & {
  /** Optional locale string falling back to the legacy global signal */
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
  format: DateFormat | Intl.DateTimeFormatOptions,
  timeZone?: string,
): Intl.DateTimeFormat {
  const cacheKey = `${locale}|${typeof format === 'string' ? format : JSON.stringify(format)}|${timeZone ?? ''}`;
  let formatter = cache.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      ...(typeof format === 'string' ? FORMAT_PRESETS[format] : format),
      timeZone,
    });
    cache.set(cacheKey, formatter);
  }

  return formatter;
}

/**
 * @example formatDate(this.date, this.locale)
 */
export function formatDate(
  date: SupportedDateInput | Signal<SupportedDateInput>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatDate(this.date, { locale: 'sl-SI', format: 'shortDate' })
 */
export function formatDate(
  date: SupportedDateInput | Signal<SupportedDateInput>,
  opt: FormatDateOptions | Signal<FormatDateOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatDate()` instead, or pass locale explicitly.
 * @example formatDate(this.date)
 */
export function formatDate(
  date: SupportedDateInput | Signal<SupportedDateInput>,
  opt?: UnsafeFormatDateOptions | Signal<UnsafeFormatDateOptions>,
): string;

export function formatDate(
  date: SupportedDateInput | Signal<SupportedDateInput>,
  optOrLocale?:
    | FormatDateOptions
    | Signal<FormatDateOptions>
    | string
    | Signal<string>
    | UnsafeFormatDateOptions
    | Signal<UnsafeFormatDateOptions>,
): string {
  const validDate = validDateOrNull(unwrap(date));
  if (validDate === null) return '';

  const unwrappedArgs = unwrap(optOrLocale);
  let locale: string;
  let format: DateFormat | Intl.DateTimeFormatOptions = 'medium';
  let tz: string | undefined;

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (unwrappedArgs && typeof unwrappedArgs === 'object') {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    format = unwrappedArgs.format ?? 'medium';
    tz = unwrappedArgs.tz;
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(locale, format, tz).format(validDate);
}

const [provideFormatDateDefaults, injectFormatDateOptions] =
  createFormatterProvider<FormatDateOptions>(
    'date',
    {
      format: 'medium',
    },
    (a, b) => {
      if (a.tz !== b.tz) return false;

      if (a.format === b.format) return true;

      return JSON.stringify(a.format) === JSON.stringify(b.format);
    },
  );

/**
 * Provide application-wide defaults for date formatting presets and timezones.
 * @example provideFormatDateDefaults({ format: 'shortDate'})
 */
export { provideFormatDateDefaults };

/**
 * Inject a context-safe date formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 * @example
 * const formatDate = injectFormatDate();
 * readonly displayDate = computed(() => formatDate(this.date()));
 */
export function injectFormatDate() {
  const defaults = injectFormatDateOptions();

  return (
    date: SupportedDateInput | Signal<SupportedDateInput>,
    optOrLocale?:
      | Partial<FormatDateOptions>
      | Signal<Partial<FormatDateOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatDate(date, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatDate(date, opt);
  };
}
