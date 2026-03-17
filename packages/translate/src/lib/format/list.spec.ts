import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { formatList } from './list';
import { TranslationStore } from '../translation-store';

describe('formatList', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  it('should format a list with conjunction as default', () => {
    TestBed.runInInjectionContext(() => {
      const result = formatList(['Apples', 'Oranges', 'Bananas']);
      expect(result).toBe('Apples, Oranges, and Bananas');
    });
  });

  it('should format a list with disjunction', () => {
    TestBed.runInInjectionContext(() => {
      const result = formatList(['Apples', 'Oranges', 'Bananas'], { type: 'disjunction' });
      expect(result).toBe('Apples, Oranges, or Bananas');
    });
  });

  it('should accept signals for value and options', () => {
    const listSignal = signal(['A', 'B']);
    const optSignal = signal({ style: 'short' as const, type: 'conjunction' as const });

    TestBed.runInInjectionContext(() => {
      const result = formatList(listSignal, optSignal);
      expect(result).toBe('A & B');
    });
  });

  it('should return empty string for empty array, null, or undefined', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatList([])).toBe('');
      expect(formatList(null)).toBe('');
      expect(formatList(undefined)).toBe('');
    });
  });

  it('should respect the provided locale', () => {
    TestBed.runInInjectionContext(() => {
      const result = formatList(['Apfel', 'Birne'], { locale: 'de-DE' });
      expect(result).toBe('Apfel und Birne');
    });
  });
});
