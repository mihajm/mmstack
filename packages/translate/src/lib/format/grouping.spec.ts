import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnit,
  injectFormatNumber,
  injectFormatUnit,
} from './numeric';

const n = (s: string) => s.replace(/\s/g, ' ');

describe("grouping follows the locale rules ('auto')", () => {
  it.each([
    ['es-ES', 1000, '1000'],
    ['es-ES', 10000, '10.000'],
    ['pl-PL', 1000, '1000'],
    ['pl-PL', 10000, '10 000'],
    ['en-US', 1000, '1,000'],
  ])('formatNumber in %s: %d -> %s', (locale, value, expected) => {
    expect(n(formatNumber(value, locale))).toBe(expected);
    expect(n(formatNumber(value, { locale }))).toBe(expected);
    expect(n(formatNumber(value, { locale, useGrouping: true }))).toBe(
      expected,
    );
  });

  it('formatUnit groups the same way', () => {
    expect(formatUnit(1000, 'meter', 'es-ES')).toBe('1000 m');
    expect(formatUnit(10000, 'meter', 'es-ES')).toBe('10.000 m');
    expect(formatUnit(1000, 'meter', 'en-US')).toBe('1,000 m');
    expect(
      formatUnit(1000, 'meter', { locale: 'es-ES', useGrouping: true }),
    ).toBe('1000 m');
  });

  it('percent and currency group the same way', () => {
    expect(n(formatPercent(10, 'es-ES'))).toBe('1000 %');
    expect(n(formatCurrency(1000, 'EUR', 'es-ES'))).toBe('1000,00 €');
    expect(n(formatCurrency(10000, 'EUR', 'es-ES'))).toBe('10.000,00 €');
  });

  it('useGrouping: false turns grouping off', () => {
    expect(formatNumber(10000, { locale: 'es-ES', useGrouping: false })).toBe(
      '10000',
    );
    expect(
      formatUnit(10000, 'meter', { locale: 'en-US', useGrouping: false }),
    ).toBe('10000 m');
  });

  it('the injected formatters default to the same grouping', () => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('es-ES');
    TestBed.runInInjectionContext(() => {
      expect(injectFormatNumber()(1000)).toBe('1000');
      expect(injectFormatNumber()(10000)).toBe('10.000');
      expect(injectFormatUnit()(1000, 'meter')).toBe('1000 m');
    });
    TestBed.inject(TranslationStore).locale.set('en-US');
    TestBed.runInInjectionContext(() => {
      expect(injectFormatUnit()(1000, 'meter')).toBe('1,000 m');
    });
  });
});
