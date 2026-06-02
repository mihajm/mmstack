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
  provideFormatCurrencyDefaults,
  provideFormatNumberDefaults,
  provideFormatPercentDefaults,
} from './numeric';
import type { inferProvideParameter } from './provide-defaults';
import {
  injectFormatRelativeTime,
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
 *       date: { dateStyle: 'medium' },
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

  return providers;
}

/**
 * Aggregate injector that returns all seven formatter helpers in a single
 * object: `date`, `displayName`, `list`, `relativeTime`, `number`, `percent`,
 * `currency`. Each is the same function you'd get from the corresponding
 * `injectFormatX()` helper. Useful when a component or service needs several
 * formatters at once.
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
 *   readonly when = computed(() => this.fmt.relativeTime(this.deltaMs(), 'second'));
 * }
 * ```
 */
export function injectFormatters() {
  return {
    date: injectFormatDate(),
    displayName: injectFormatDisplayName(),
    list: injectFormatList(),
    relativeTime: injectFormatRelativeTime(),
    number: injectFormatNumber(),
    percent: injectFormatPercent(),
    currency: injectFormatCurrency(),
  };
}
