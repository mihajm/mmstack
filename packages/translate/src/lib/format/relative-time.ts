import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
import { mergeDefined, unwrap } from './unwrap';

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
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatRelativeTimeOptions = Omit<
  FormatRelativeTimeOptions,
  'locale'
> & {
  /** Optional locale string falling back to the legacy global signal */
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
 * @example formatRelativeTime(this.value, this.unit, this.locale)
 */
export function formatRelativeTime(
  value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
  unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatRelativeTime(this.value, 'day', { locale: 'sl-SI', numeric: 'auto' })
 */
export function formatRelativeTime(
  value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
  unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
  opt: FormatRelativeTimeOptions | Signal<FormatRelativeTimeOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatRelativeTime()` instead, or pass locale explicitly.
 * @example formatRelativeTime(this.value, 'day')
 */
export function formatRelativeTime(
  value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
  unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
  opt?:
    | UnsafeFormatRelativeTimeOptions
    | Signal<UnsafeFormatRelativeTimeOptions>,
): string;

export function formatRelativeTime(
  value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
  unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
  optOrLocale?:
    | FormatRelativeTimeOptions
    | Signal<FormatRelativeTimeOptions>
    | string
    | Signal<string>
    | UnsafeFormatRelativeTimeOptions
    | Signal<UnsafeFormatRelativeTimeOptions>,
): string {
  const unwrappedValue = unwrap(value);
  // Number.isFinite also rejects ±Infinity, which Intl.RelativeTimeFormat throws on
  if (unwrappedValue == null || !Number.isFinite(unwrappedValue)) return '';

  const unwrappedUnit = unwrap(unit);
  if (!unwrappedUnit) return '';

  const unwrappedArgs = unwrap(optOrLocale);
  let locale: string;
  let style: Intl.RelativeTimeFormatStyle = 'long';
  let numeric: Intl.RelativeTimeFormatNumeric = 'always';

  if (typeof unwrappedArgs === 'string') {
    locale = unwrappedArgs;
  } else if (unwrappedArgs && typeof unwrappedArgs === 'object') {
    locale = unwrappedArgs.locale ?? readLocaleUnsafe();
    style = unwrappedArgs.style ?? 'long';
    numeric = unwrappedArgs.numeric ?? 'always';
  } else {
    locale = readLocaleUnsafe();
  }

  return getFormatter(locale, style, numeric).format(
    unwrappedValue,
    unwrappedUnit,
  );
}

const [provideFormatRelativeTimeDefaults, injectFormatRelativeTimeOptions] =
  createFormatterProvider<FormatRelativeTimeOptions>(
    'relativeTime',
    {
      style: 'long',
      numeric: 'always',
    },
    (a, b) => a.style === b.style && a.numeric === b.numeric,
  );

/**
 * Provide application-wide defaults for relative time formatting presets.
 * @example provideFormatRelativeTimeDefaults({ numeric: 'auto' })
 */
export { provideFormatRelativeTimeDefaults };

/**
 * Reference instants in seconds per unit, used by {@link formatRelativeTimeToNow} to pick
 * the largest unit whose magnitude is at least 1. Weeks/months use calendar averages
 * (4.34524 weeks/month), which is the standard approximation for "x ago" displays —
 * supply an explicit unit via {@link formatRelativeTime} when exactness matters.
 */
const DIVISIONS: { amount: number; unit: RelativeTimeUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Infinity, unit: 'year' },
];

function selectUnit(deltaSeconds: number): {
  value: number;
  unit: RelativeTimeUnit;
} {
  let duration = deltaSeconds;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return { value: Math.round(duration), unit: division.unit };
    }
    duration /= division.amount;
  }
  return { value: Math.round(duration), unit: 'year' };
}

export type FormatRelativeTimeToNowOptions = FormatRelativeTimeOptions & {
  /**
   * The reference instant to diff against, mostly useful for testing.
   * @default Date.now()
   */
  now?: number | Date;
};

/**
 * Formats a date/timestamp relative to now ("3 days ago", "in 2 hours"), picking the
 * largest fitting unit automatically — the `date-fns formatDistanceToNow` ergonomics on
 * top of `Intl.RelativeTimeFormat`. Invalid/nullish input formats to `''`.
 *
 * Pass `numeric: 'auto'` for natural phrasing ("yesterday", "last month") instead of
 * the default numeric form ("1 day ago").
 *
 * @example
 * formatRelativeTimeToNow(post.createdAt, { locale: 'en-US' }); // "3 days ago"
 * formatRelativeTimeToNow(due, { locale: 'sl-SI', numeric: 'auto' });
 */
export function formatRelativeTimeToNow(
  date:
    | Date
    | string
    | number
    | null
    | undefined
    | Signal<Date | string | number | null | undefined>,
  opt: FormatRelativeTimeToNowOptions | Signal<FormatRelativeTimeToNowOptions>,
): string {
  const unwrapped = unwrap(date);
  if (unwrapped == null) return '';

  const d = unwrapped instanceof Date ? unwrapped : new Date(unwrapped);
  if (isNaN(d.getTime())) return '';

  const o = unwrap(opt);
  const nowOpt = o.now ?? Date.now();
  const now = nowOpt instanceof Date ? nowOpt.getTime() : nowOpt;

  const { value, unit } = selectUnit((d.getTime() - now) / 1000);
  return formatRelativeTime(value, unit, {
    locale: o.locale,
    style: o.style,
    numeric: o.numeric,
  });
}

/**
 * Inject a context-safe "relative to now" formatter tied to the current injector — the
 * auto-unit sibling of {@link injectFormatRelativeTime}. Reacts to locale/config changes.
 *
 * @example
 * const toNow = injectFormatRelativeTimeToNow();
 * readonly age = computed(() => toNow(this.createdAt()));
 */
export function injectFormatRelativeTimeToNow() {
  const defaults = injectFormatRelativeTimeOptions();

  return (
    date:
      | Date
      | string
      | number
      | null
      | undefined
      | Signal<Date | string | number | null | undefined>,
    optOrLocale?:
      | Partial<FormatRelativeTimeToNowOptions>
      | Signal<Partial<FormatRelativeTimeToNowOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatRelativeTimeToNow(date, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? mergeDefined(
            defaults() as FormatRelativeTimeToNowOptions,
            unwrapped,
          )
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatRelativeTimeToNow(date, opt);
  };
}

/**
 * Inject a context-safe relative time formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 * @example
 * const formatRelativeTime = injectFormatRelativeTime();
 * readonly relativeAge = computed(() => formatRelativeTime(this.delta(), 'day'));
 */
export function injectFormatRelativeTime() {
  const defaults = injectFormatRelativeTimeOptions();

  return (
    value: SupportedRelativeTimeInput | Signal<SupportedRelativeTimeInput>,
    unit: RelativeTimeUnit | Signal<RelativeTimeUnit>,
    optOrLocale?:
      | Partial<FormatRelativeTimeOptions>
      | Signal<Partial<FormatRelativeTimeOptions>>
      | string
      | Signal<string>,
  ) => {
    if (!optOrLocale) return formatRelativeTime(value, unit, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? mergeDefined(defaults(), unwrapped)
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatRelativeTime(value, unit, opt);
  };
}
