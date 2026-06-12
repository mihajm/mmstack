import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatUnit,
} from './numeric';

describe('numeric formatting', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  describe('formatNumber', () => {
    it('should format a number with standard options', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatNumber(1234567.89)).toBe('1,234,567.89');
      });
    });

    it('should handle decimal places based on options', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatNumber(10, { minFractionDigits: 2 })).toBe('10.00');
        expect(formatNumber(10.1234, { maxFractionDigits: 2 })).toBe('10.12');
      });
    });

    it('should use grouping based on options', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatNumber(1000, { useGrouping: false })).toBe('1000');
      });
    });

    it('should support notations', () => {
      TestBed.runInInjectionContext(() => {
        const compact = formatNumber(1500000, { notation: 'compact' });
        expect(compact).toBe('1.5M');
      });
    });

    it('should handle null/undefined/NaN based on fallbackToZero', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatNumber(null)).toBe('');
        expect(formatNumber(undefined)).toBe('');
        expect(formatNumber(NaN)).toBe('');

        expect(formatNumber(null, { fallbackToZero: true })).toBe('0');
        expect(formatNumber(undefined, { fallbackToZero: true })).toBe('0');
        expect(formatNumber(NaN, { fallbackToZero: true })).toBe('0');
      });
    });

    it('should work with signals', () => {
      const numSignal = signal(1234.5);
      const optSignal = signal({ notation: 'standard' as const });

      TestBed.runInInjectionContext(() => {
        expect(formatNumber(numSignal, optSignal)).toBe('1,234.5');
      });
    });

    it('should respect the locale', () => {
      TestBed.runInInjectionContext(() => {
        const result = formatNumber(1234.56, { locale: 'de-DE' });
        // German uses period for grouping and comma for decimals: "1.234,56"
        expect(result).toBe('1.234,56');
      });
    });

    it('should accept an explicit locale string (SSR-safe overload)', () => {
      expect(formatNumber(1234.56, 'de-DE')).toBe('1.234,56');
    });
  });

  describe('formatPercent', () => {
    it('should format a number as a percentage', () => {
      TestBed.runInInjectionContext(() => {
        // 0.5 is 50%
        expect(formatPercent(0.5)).toBe('50%');
      });
    });

    it('should respect decimal places', () => {
      TestBed.runInInjectionContext(() => {
        expect(
          formatPercent(0.1234, { minFractionDigits: 1, maxFractionDigits: 1 }),
        ).toBe('12.3%');
      });
    });

    it('should fallback to zero when requested', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatPercent(null, { fallbackToZero: true })).toBe('0%');
      });
    });

    it('should accept an explicit locale string (SSR-safe overload)', () => {
      expect(formatPercent(0.5, 'de-DE')).toBe('50 %');
    });
  });

  describe('formatCurrency', () => {
    it('should format a number as currency', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
        expect(formatCurrency(1234.5, 'EUR')).toBe('€1,234.50');
      });
    });

    it('should use different display options', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatCurrency(100, 'USD', { display: 'code' })).toBe(
          'USD 100.00',
        ); // Might contain a non-breaking space
      });
    });

    it('should handle signals for value, currency, and options', () => {
      const val = signal(50);
      const currency = signal('GBP');
      const opt = signal({ display: 'symbol' as const });

      TestBed.runInInjectionContext(() => {
        expect(formatCurrency(val, currency, opt)).toBe('£50.00');
      });
    });

    it('should accept an explicit locale string (SSR-safe overload)', () => {
      // German formatting: "1.234,50 €"
      expect(formatCurrency(1234.5, 'EUR', 'de-DE')).toBe('1.234,50 €');
    });
    it('should support fraction-digit control', () => {
      expect(
        formatCurrency(1234.56, 'USD', {
          locale: 'en-US',
          maxFractionDigits: 0,
        }),
      ).toBe('$1,235');
    });

    it('should support signDisplay', () => {
      expect(
        formatCurrency(5, 'USD', {
          locale: 'en-US',
          signDisplay: 'exceptZero',
        }),
      ).toBe('+$5.00');
    });
  });

  describe('modern number options', () => {
    it('should support signDisplay on plain numbers', () => {
      expect(
        formatNumber(5, { locale: 'en-US', signDisplay: 'exceptZero' }),
      ).toBe('+5');
      expect(
        formatNumber(0, { locale: 'en-US', signDisplay: 'exceptZero' }),
      ).toBe('0');
    });

    it('should support roundingMode', () => {
      expect(
        formatNumber(2.5, {
          locale: 'en-US',
          maxFractionDigits: 0,
          roundingMode: 'floor',
        }),
      ).toBe('2');
      expect(
        formatNumber(2.5, {
          locale: 'en-US',
          maxFractionDigits: 0,
          roundingMode: 'halfExpand',
        }),
      ).toBe('3');
    });
  });

  describe('formatUnit', () => {
    it('formats sanctioned units and -per- compounds', () => {
      expect(formatUnit(16, 'kilometer-per-hour', 'en-US')).toBe('16 km/h');
      expect(
        formatUnit(2.5, 'liter', { locale: 'en-US', unitDisplay: 'long' }),
      ).toBe('2.5 liters');
    });

    it('returns empty string for invalid input (unless fallbackToZero)', () => {
      expect(formatUnit(null, 'liter', 'en-US')).toBe('');
      expect(
        formatUnit(null, 'liter', { locale: 'en-US', fallbackToZero: true }),
      ).toBe('0 L');
    });
  });
});
