import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnit,
  injectFormatCurrency,
  injectFormatNumber,
  injectFormatPercent,
  injectFormatUnit,
} from './numeric';

const n = (s: string) => s.replace(/\s/g, ' ');

describe('numeric formatter options', () => {
  it('does not share a cached formatter across signDisplay values', () => {
    expect(
      formatNumber(5, { locale: 'en-US', signDisplay: 'exceptZero' }),
    ).toBe('+5');
    expect(formatNumber(-5, { locale: 'en-US', signDisplay: 'never' })).toBe(
      '5',
    );
  });

  it('formats invalid percent and currency input as an empty string', () => {
    expect(formatPercent(null, 'en-US')).toBe('');
    expect(formatCurrency(null, 'USD', 'en-US')).toBe('');
  });

  it('an explicit locale in the options object wins over the active locale', () => {
    expect(n(formatPercent(0.5, { locale: 'de-DE' }))).toBe('50 %');
    expect(n(formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }))).toBe(
      '1.234,50 €',
    );
  });

  it('formatUnit takes a string locale', () => {
    expect(formatUnit(1234.5, 'kilometer-per-hour', 'de-DE')).toBe(
      '1.234,5 km/h',
    );
  });
});

describe('numeric no-locale overloads read the active locale', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('de-DE');
  });

  afterEach(() => TestBed.inject(TranslationStore).locale.set('en-US'));

  it('formats with the active locale', () => {
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(n(formatPercent(0.5))).toBe('50 %');
    expect(n(formatCurrency(1234.5, 'EUR'))).toBe('1.234,50 €');
  });

  it('the injected unit formatter switches with the active locale', () => {
    TestBed.runInInjectionContext(() => {
      expect(injectFormatUnit()(1234.5, 'kilometer-per-hour')).toBe(
        '1.234,5 km/h',
      );
    });
  });
});

describe('injected numeric formatters take per-call options and locales', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('en-US');
  });

  it('number', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatNumber();
      expect(fmt(10, { minFractionDigits: 2 })).toBe('10.00');
      expect(fmt(1234.5, 'de-DE')).toBe('1.234,5');
      expect(fmt(1234.5)).toBe('1,234.5');
    });
  });

  it('percent', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatPercent();
      expect(fmt(0.1234, { maxFractionDigits: 1 })).toBe('12.3%');
      expect(n(fmt(0.5, 'de-DE'))).toBe('50 %');
    });
  });

  it('currency', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatCurrency();
      expect(n(fmt(1234.5, 'USD', { display: 'code' }))).toBe('USD 1,234.50');
      expect(n(fmt(1234.5, 'EUR', 'de-DE'))).toBe('1.234,50 €');
    });
  });

  it('unit', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatUnit();
      expect(fmt(2.5, 'liter', { unitDisplay: 'long' })).toBe('2.5 liters');
      expect(fmt(1234.5, 'kilometer-per-hour', 'de-DE')).toBe('1.234,5 km/h');
    });
  });
});
