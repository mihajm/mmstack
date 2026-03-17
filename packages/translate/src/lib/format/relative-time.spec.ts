import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { formatRelativeTime } from './relative-time';
import { TranslationStore } from '../translation-store';

describe('formatRelativeTime', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  it('should format a relative time', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatRelativeTime(-1, 'day')).toBe('1 day ago');
      expect(formatRelativeTime(2, 'month')).toBe('in 2 months');
    });
  });

  it('should support numeric options', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday');
      expect(formatRelativeTime(-1, 'day', { numeric: 'always' })).toBe('1 day ago');
    });
  });

  it('should work with signals', () => {
    const val = signal(1);
    const unit = signal<Intl.RelativeTimeFormatUnit>('week');
    const opt = signal({ numeric: 'auto' as const });
    
    TestBed.runInInjectionContext(() => {
      expect(formatRelativeTime(val, unit, opt)).toBe('next week');
    });
  });

  it('should return empty string for invalid dates', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatRelativeTime(null, 'day')).toBe('');
      expect(formatRelativeTime(undefined, 'day')).toBe('');
      expect(formatRelativeTime(NaN, 'day')).toBe('');
    });
  });

  it('should respect the given locale', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatRelativeTime(-1, 'day', { locale: 'de-DE', numeric: 'auto' })).toBe('gestern');
    });
  });
});
