import { type Signal } from '@angular/core';
import { readLocaleUnsafe } from '../translation-store';
import { createFormatterProvider } from './provide-defaults';
import { unwrap } from './unwrap';

const cache = new Map<string, Intl.DisplayNames>();

/**
 * Options for formatting a display name
 */
export type FormatDisplayNameOptions = {
  /**
   * The display style for the result set
   * @default 'long'
   */
  style?: Intl.RelativeTimeFormatStyle;
  /**
   * Locale to use for formatting
   */
  locale: string;
};

/**
 * @deprecated UNSAFE FOR SSR/EDGE. Omitting the locale property forces a fallback to a process-level global singleton.
 */
export type UnsafeFormatDisplayNameOptions = Omit<
  FormatDisplayNameOptions,
  'locale'
> & {
  /** Optional locale string falling back to the legacy global signal */
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
 * @example formatDisplayName(this.value, 'region', this.locale)
 */
export function formatDisplayName(
  value: SupportedCode | Signal<SupportedCode>,
  type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
  locale: string | Signal<string>,
): string;

/**
 * @example formatDisplayName(this.value, 'region', {locale: 'en-US', style: 'long'})
 */
export function formatDisplayName(
  value: SupportedCode | Signal<SupportedCode>,
  type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
  opt: FormatDisplayNameOptions | Signal<FormatDisplayNameOptions>,
): string;

/**
 * @deprecated UNSAFE FOR SSR/EDGE. This signature reads from a process-level global singleton, will be fully removed when Angular 23 drops
 * Use `injectFormatDisplayName()` instead, or pass locale explicitly.
 * @example formatDisplayName(this.value)
 */
export function formatDisplayName(
  value: SupportedCode | Signal<SupportedCode>,
  type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
  opt?: UnsafeFormatDisplayNameOptions | Signal<UnsafeFormatDisplayNameOptions>,
): string;

/**
 * Format a display name using the current or provided locale
 *
 * @param value - The code to format
 * @param type - The type of display name to format
 * @param opt - Options for formatting
 * @returns Formatted display name string
 */
export function formatDisplayName(
  value: SupportedCode | Signal<SupportedCode>,
  type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
  localeOrOpt?:
    | FormatDisplayNameOptions
    | Signal<FormatDisplayNameOptions>
    | string
    | Signal<string>
    | UnsafeFormatDisplayNameOptions
    | Signal<UnsafeFormatDisplayNameOptions>,
) {
  const unwrappedValue = unwrap(value);
  if (!unwrappedValue?.trim()) return '';

  const unwrappedType = unwrap(type);
  const unwrapped = unwrap(localeOrOpt);

  const locale =
    typeof unwrapped === 'string'
      ? unwrapped
      : (unwrapped?.locale ?? readLocaleUnsafe());

  const opt = typeof unwrapped === 'object' ? unwrapped : undefined;

  return (
    getFormatter(locale, unwrappedType, opt?.style ?? 'long').of(
      unwrappedValue,
    ) ?? ''
  );
}

const [provideFormatDisplayNameDefaults, injectFormatDisplayNameDefaults] =
  createFormatterProvider<FormatDisplayNameOptions>(
    'displayName',
    {
      style: 'long',
    },
    (a, b) => a.style === b.style,
  );

/**
 * Provide application-wide defaults for display name formatting presets and timezones.
 * @example provideFormatDisplayNameDefaults({ style: 'long'})
 */
export { provideFormatDisplayNameDefaults };

/**
 * Inject a context-safe date formatting function tied to the current injector.
 * Uses the libraries locale signal & provided default configuration to react to locale/config changes
 * @example
 * const formatDisplayName = injectFormatDisplayName();
 * readonly region = computed(() => formatDisplayName('US', 'region'));
 */
export function injectFormatDisplayName() {
  const defaults = injectFormatDisplayNameDefaults();

  return (
    value: SupportedCode | Signal<SupportedCode>,
    type: Intl.DisplayNamesType | Signal<Intl.DisplayNamesType>,
    localeOrOpt?:
      | FormatDisplayNameOptions
      | Signal<FormatDisplayNameOptions>
      | string
      | Signal<string>,
  ): string => {
    if (!localeOrOpt) return formatDisplayName(value, type, defaults());

    const unwrapped = unwrap(localeOrOpt);
    const opt =
      typeof unwrapped === 'object'
        ? { ...defaults(), ...unwrapped }
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return formatDisplayName(value, type, opt);
  };
}
