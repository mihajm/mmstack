import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { formatDate } from './date';
import { TranslationStore } from '../translation-store';

describe('formatDate', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    // Reset to en-US for consistent tests
    store.locale.set('en-US');
  });

  it('should format a Date object with default options', () => {
    const date = new Date('2024-01-01T12:00:00Z');
    
    TestBed.runInInjectionContext(() => {
      // In en-US, medium format varies slightly by browser/node, but should look roughly like "Jan 1, 2024, 12:00:00 PM"
      // Wait, node timezones vary, so better use UTC for the test
      const result = formatDate(date, { tz: 'UTC' });
      expect(result).toContain('Jan 1, 2024');
    });
  });

  it('should accept a signal as value', () => {
    const dateSignal = signal(new Date('2024-01-01T12:00:00Z'));
    
    TestBed.runInInjectionContext(() => {
      const result = formatDate(dateSignal, { tz: 'UTC' });
      expect(result).toContain('Jan 1, 2024');
    });
  });

  it('should accept a signal as options', () => {
    const date = new Date('2024-01-01T12:00:00Z');
    const optSignal = signal({ tz: 'UTC', format: 'shortDate' as const });
    
    TestBed.runInInjectionContext(() => {
      const result = formatDate(date, optSignal);
      // shortDate typically "1/1/24" in en-US
      expect(result).toMatch(/1\/1\/24|01\/01\/2024/); 
    });
  });

  it('should return empty string for null or invalid dates', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatDate(null)).toBe('');
      expect(formatDate(undefined)).toBe('');
      expect(formatDate('invalid-date')).toBe('');
    });
  });

  it('should respect the provided locale', () => {
    const date = new Date('2024-01-01T12:00:00Z');
    
    TestBed.runInInjectionContext(() => {
      const result = formatDate(date, { locale: 'de-DE', tz: 'UTC', format: 'mediumDate' });
      // German medium date is "01.01.2024" or "1. Jan. 2024" depending on node version, let's just check for "2024"
      expect(result).toContain('2024');
      expect(result).not.toContain('Jan 1'); // Not english
    });
  });

  it('should apply different presets correctly', () => {
    const date = new Date('2024-01-01T12:00:00Z');
    
    TestBed.runInInjectionContext(() => {
      const dateOnly = formatDate(date, { format: 'shortDate', tz: 'UTC' });
      const timeOnly = formatDate(date, { format: 'shortTime', tz: 'UTC' });
      
      expect(dateOnly.length).toBeGreaterThan(0);
      expect(timeOnly.length).toBeGreaterThan(0);
      expect(dateOnly).not.toEqual(timeOnly);
    });
  });
});
