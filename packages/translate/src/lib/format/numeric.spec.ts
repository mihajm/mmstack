import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { formatNumber, formatPercent, formatCurrency } from './numeric';
import { TranslationStore } from '../translation-store';

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
        expect(formatPercent(0.1234, { minFractionDigits: 1, maxFractionDigits: 1 })).toBe('12.3%');
      });
    });
    
    it('should fallback to zero when requested', () => {
      TestBed.runInInjectionContext(() => {
        expect(formatPercent(null, { fallbackToZero: true })).toBe('0%');
      });
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
        expect(formatCurrency(100, 'USD', { display: 'code' })).toBe('USD 100.00'); // Might contain a non-breaking space
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
  });
});
