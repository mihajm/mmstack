import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
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
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omiting the locale property forces a fallback to a process-level global singleton.
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
  if (
    unwrappedValue === null ||
    unwrappedValue === undefined ||
    isNaN(unwrappedValue)
  )
    return '';

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
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatRelativeTime(value, unit, opt);
  };
}
