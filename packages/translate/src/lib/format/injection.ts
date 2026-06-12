import type { Provider } from '@angular/core';
import { injectFormatDate, provideFormatDateDefaults } from './date';
import {
  injectFormatDisplayName,
  provideFormatDisplayNameDefaults,
} from './display-name';
import { injectFormatList, provideFormatListDefaults } from './list';
import {
  injectFormatCurrency,
  injectFormatNumber,
  injectFormatPercent,
  injectFormatUnit,
  provideFormatCurrencyDefaults,
  provideFormatNumberDefaults,
  provideFormatPercentDefaults,
  provideFormatUnitDefaults,
} from './numeric';
import {
  injectSelectPlural,
  provideSelectPluralDefaults,
} from './plural-rules';
import type { inferProvideParameter } from './provide-defaults';
import {
  injectFormatRelativeTime,
  injectFormatRelativeTimeToNow,
  provideFormatRelativeTimeDefaults,
} from './relative-time';

type FormatDefaults = {
  date?: inferProvideParameter<typeof provideFormatDateDefaults>;
  displayName?: inferProvideParameter<typeof provideFormatDisplayNameDefaults>;
  list?: inferProvideParameter<typeof provideFormatListDefaults>;
  relativeTime?: inferProvideParameter<
    typeof provideFormatRelativeTimeDefaults
  >;
  number?: inferProvideParameter<typeof provideFormatNumberDefaults>;
  percent?: inferProvideParameter<typeof provideFormatPercentDefaults>;
  currency?: inferProvideParameter<typeof provideFormatCurrencyDefaults>;
  unit?: inferProvideParameter<typeof provideFormatUnitDefaults>;
  plural?: inferProvideParameter<typeof provideSelectPluralDefaults>;
};

/**
 * Provide application-wide defaults for every format preset (date, displayName,
 * list, relativeTime, number, percent, currency) in a single call, instead of
 * calling each `provideFormatXDefaults()` individually. Pass only the presets
 * you want to override; the rest fall back to the package defaults.
 *
 * @param cfg Per-preset defaults — each key is optional.
 * @returns A providers array to spread into `bootstrapApplication`'s `providers`.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     ...provideFormatDefaults({
 *       number: { notation: 'compact' },
 *       currency: { display: 'code' },
 *       date: { format: 'medium' },
 *     }),
 *   ],
 * });
 * ```
 */
export function provideFormatDefaults(cfg: FormatDefaults): Provider[] {
  const providers: Provider[] = [];
  if (cfg.date) providers.push(provideFormatDateDefaults(cfg.date));
  if (cfg.displayName)
    providers.push(provideFormatDisplayNameDefaults(cfg.displayName));
  if (cfg.list) providers.push(provideFormatListDefaults(cfg.list));
  if (cfg.relativeTime)
    providers.push(provideFormatRelativeTimeDefaults(cfg.relativeTime));
  if (cfg.number) providers.push(provideFormatNumberDefaults(cfg.number));
  if (cfg.percent) providers.push(provideFormatPercentDefaults(cfg.percent));
  if (cfg.currency) providers.push(provideFormatCurrencyDefaults(cfg.currency));
  if (cfg.unit) providers.push(provideFormatUnitDefaults(cfg.unit));
  if (cfg.plural) providers.push(provideSelectPluralDefaults(cfg.plural));

  return providers;
}

/**
 * Aggregate injector that returns all formatter helpers in a single object:
 * `date`, `displayName`, `list`, `relativeTime`, `relativeTimeToNow`, `number`,
 * `percent`, `currency`, `plural`. Each is the same function you'd get from the
 * corresponding `injectFormatX()` helper. Useful when a component or service
 * needs several formatters at once.
 *
 * @returns An object keyed by formatter name; each value is the matching format function.
 *
 * @example
 * ```ts
 * @Component({ ... })
 * class StatsComponent {
 *   private readonly fmt = injectFormatters();
 *   readonly total = computed(() => this.fmt.number(this.count()));
 *   readonly revenue = computed(() => this.fmt.currency(this.sales(), 'USD'));
 *   // value must already be in the named unit (5 → "in 5 seconds")
 *   readonly eta = computed(() => this.fmt.relativeTime(this.deltaSeconds(), 'second'));
 *   // or let the unit be picked automatically from a date/timestamp:
 *   readonly age = computed(() => this.fmt.relativeTimeToNow(this.createdAt()));
 * }
 * ```
 */
export function injectFormatters() {
  return {
    date: injectFormatDate(),
    displayName: injectFormatDisplayName(),
    list: injectFormatList(),
    relativeTime: injectFormatRelativeTime(),
    relativeTimeToNow: injectFormatRelativeTimeToNow(),
    number: injectFormatNumber(),
    percent: injectFormatPercent(),
    currency: injectFormatCurrency(),
    unit: injectFormatUnit(),
    plural: injectSelectPlural(),
  };
}
