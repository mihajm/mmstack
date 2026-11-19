import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatDate,
  injectFormatDate,
  provideFormatDateDefaults,
} from './date';
import { injectFormatters, provideFormatDefaults } from './injection';
import { injectFormatNumber, provideFormatNumberDefaults } from './numeric';

const d = new Date(Date.UTC(2024, 0, 1, 12));
const n = (s: string) => s.replace(/\s/g, ' ');

function inChild<T>(providers: unknown[], fn: () => T): T {
  const parent = TestBed.inject(EnvironmentInjector);
  const child = createEnvironmentInjector(providers as never[], parent);
  try {
    return child.runInContext(fn);
  } finally {
    child.destroy();
  }
}

describe('provideFormatDefaults', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('en-US');
  });

  it('applies the defaults of every key', () => {
    const fmt = inChild(
      provideFormatDefaults({
        date: { format: 'shortDate', tz: 'UTC' },
        displayName: { style: 'short' },
        list: { type: 'disjunction' },
        relativeTime: { numeric: 'auto' },
        number: { minFractionDigits: 2 },
        percent: { minFractionDigits: 1 },
        currency: { display: 'code' },
        unit: { unitDisplay: 'long' },
        plural: { type: 'ordinal' },
      }),
      () => injectFormatters(),
    );

    expect(fmt.date(d)).toBe(
      formatDate(d, { locale: 'en-US', tz: 'UTC', format: 'shortDate' }),
    );
    expect(fmt.displayName('GB', 'region')).toBe('UK');
    expect(fmt.list(['a', 'b'])).toBe('a or b');
    expect(fmt.relativeTime(-1, 'day')).toBe('yesterday');
    expect(fmt.relativeTimeToNow(Date.now() - 86_400_000)).toBe('yesterday');
    expect(fmt.number(10)).toBe('10.00');
    expect(fmt.percent(0.5)).toBe('50.0%');
    expect(n(fmt.currency(1, 'USD'))).toBe('USD 1.00');
    expect(fmt.unit(2.5, 'liter')).toBe('2.5 liters');
    expect(fmt.plural(2)).toBe('two');
  });

  it('leaves the presets it does not name to the parent injector', () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const mid = createEnvironmentInjector(
      [
        provideFormatDateDefaults({ format: 'shortDate', tz: 'UTC' }),
        provideFormatNumberDefaults({ minFractionDigits: 2 }),
      ],
      parent,
    );
    const child = createEnvironmentInjector(
      provideFormatDefaults({ list: { type: 'disjunction' } }),
      mid,
    );
    child.runInContext(() => {
      expect(injectFormatDate()(d)).toBe(
        formatDate(d, { locale: 'en-US', tz: 'UTC', format: 'shortDate' }),
      );
      expect(injectFormatNumber()(10)).toBe('10.00');
    });
    child.destroy();
    mid.destroy();
  });

  it('returns no providers for an empty config', () => {
    expect(provideFormatDefaults({})).toEqual([]);
  });
});

describe('injectFormatters', () => {
  it('exposes every formatter with the library defaults', () => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('en-US');
    const fmt = TestBed.runInInjectionContext(() => injectFormatters());
    expect(fmt.date(d)).toBe(formatDate(d, { locale: 'en-US' }));
    expect(fmt.displayName('GB', 'region')).toBe('United Kingdom');
    expect(fmt.list(['a', 'b'])).toBe('a and b');
    expect(fmt.relativeTime(-1, 'day')).toBe('1 day ago');
    expect(fmt.relativeTimeToNow(Date.now() - 86_400_000)).toBe('1 day ago');
    expect(fmt.number(1234.5)).toBe('1,234.5');
    expect(fmt.percent(0.5)).toBe('50%');
    expect(fmt.currency(1, 'USD')).toBe('$1.00');
    expect(fmt.unit(2.5, 'liter')).toBe('2.5 L');
    expect(fmt.plural(2)).toBe('other');
  });
});
