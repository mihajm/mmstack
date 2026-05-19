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
