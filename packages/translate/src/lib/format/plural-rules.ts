import { type Signal } from '@angular/core';
import { createFormatterProvider } from './provide-defaults';
import { mergeDefined, unwrap } from './unwrap';

const cache = new Map<string, Intl.PluralRules>();

/**
 * Options for selecting a plural category.
 */
export type SelectPluralOptions = {
  /**
   * Cardinal ("1 item, 2 items") or ordinal ("1st, 2nd, 3rd") rules.
   * @default 'cardinal'
   */
  type?: Intl.PluralRuleType;
  /**
   * Locale to use for plural selection.
   */
  locale: string;
};

function getRules(
  locale: string,
  type: Intl.PluralRuleType,
): Intl.PluralRules {
  const cacheKey = `${locale}|${type}`;
  let rules = cache.get(cacheKey);

  if (!rules) {
    rules = new Intl.PluralRules(locale, { type });
    cache.set(cacheKey, rules);
  }

  return rules;
}

type SupportedPluralInput = number | null | undefined;

/**
 * Selects the CLDR plural category (`zero | one | two | few | many | other`) for a value —
 * a thin, cached wrapper over `Intl.PluralRules`. Useful for keying custom message maps
 * when the full ICU `{x, plural, ...}` syntax is overkill, or for class/markup branching.
 *
 * Invalid/nullish input selects `'other'` (the category every locale defines).
 *
 * @example
 * selectPluralCategory(1, { locale: 'en-US' }); // 'one'
 * selectPluralCategory(3, { locale: 'sl-SI' }); // 'few'
 * selectPluralCategory(2, { locale: 'en-US', type: 'ordinal' }); // 'two' → "2nd"
 */
export function selectPluralCategory(
  value: SupportedPluralInput | Signal<SupportedPluralInput>,
  opt: SelectPluralOptions | Signal<SelectPluralOptions>,
): Intl.LDMLPluralRule {
  const unwrappedValue = unwrap(value);
  if (unwrappedValue == null || !Number.isFinite(unwrappedValue))
    return 'other';

  const o = unwrap(opt);
  return getRules(o.locale, o.type ?? 'cardinal').select(unwrappedValue);
}

const [provideSelectPluralDefaults, injectSelectPluralOptions] =
  createFormatterProvider<SelectPluralOptions>(
    'pluralRules',
    {
      type: 'cardinal',
    },
    (a, b) => a.type === b.type,
  );

/**
 * Provide application-wide defaults for plural-category selection.
 * @example provideSelectPluralDefaults({ type: 'ordinal' })
 */
export { provideSelectPluralDefaults };

/**
 * Inject a context-safe plural-category selector tied to the current injector.
 * Uses the library's locale signal & provided default configuration, so the
 * category re-resolves on locale changes.
 *
 * @example
 * const plural = injectSelectPlural();
 * readonly badgeClass = computed(() => `badge--${plural(this.count())}`);
 */
export function injectSelectPlural() {
  const defaults = injectSelectPluralOptions();

  return (
    value: SupportedPluralInput | Signal<SupportedPluralInput>,
    optOrLocale?:
      | Partial<SelectPluralOptions>
      | Signal<Partial<SelectPluralOptions>>
      | string
      | Signal<string>,
  ): Intl.LDMLPluralRule => {
    if (!optOrLocale) return selectPluralCategory(value, defaults());

    const unwrapped = unwrap(optOrLocale);

    const opt =
      typeof unwrapped === 'object'
        ? mergeDefined(defaults(), unwrapped)
        : {
            ...defaults(),
            locale: unwrapped,
          };

    return selectPluralCategory(value, opt);
  };
}
