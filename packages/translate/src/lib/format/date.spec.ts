import { inject, Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatDate,
  injectFormatDate,
  provideFormatDateDefaults,
} from './date';

describe('formatDate', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  it('should format a Date object with default options', () => {
    const date = new Date('2024-01-01T12:00:00Z');

    TestBed.runInInjectionContext(() => {
      const result = formatDate(date, { tz: 'UTC', locale: store.locale() });
      expect(result).toContain('Jan 1, 2024');
      expect(injectFormatDate()(date, { tz: 'UTC' })).toBe(result);
    });
  });

  it('should accept a signal as value', () => {
    const dateSignal = signal(new Date('2024-01-01T12:00:00Z'));

    TestBed.runInInjectionContext(() => {
      const result = formatDate(dateSignal, {
        tz: 'UTC',
        locale: store.locale(),
      });
      expect(result).toContain('Jan 1, 2024');
    });
  });

  it('should accept a signal as options', () => {
    const date = new Date('2024-01-01T12:00:00Z');
    const optSignal = signal({
      tz: 'UTC',
      format: 'shortDate' as const,
      locale: store.locale(),
    });

    TestBed.runInInjectionContext(() => {
      const result = formatDate(date, optSignal);
      expect(result).toMatch(/1\/1\/24|01\/01\/2024/);
    });
  });

  it('should return empty string for null or invalid dates', () => {
    TestBed.runInInjectionContext(() => {
      expect(formatDate(null, { locale: store.locale() })).toBe('');
      expect(formatDate(undefined, { locale: store.locale() })).toBe('');
      expect(formatDate('invalid-date', { locale: store.locale() })).toBe('');
    });
  });

  it('should respect the provided locale', () => {
    const date = new Date('2024-01-01T12:00:00Z');

    TestBed.runInInjectionContext(() => {
      const result = formatDate(date, {
        locale: 'de-DE',
        tz: 'UTC',
        format: 'mediumDate',
      });
      expect(result).toContain('2024');
      expect(result).not.toContain('Jan 1');
    });
  });

  it('should honor a timeZone supplied inside a custom format object', () => {
    const date = new Date('2024-06-01T00:30:00Z');

    TestBed.runInInjectionContext(() => {
      const viaFormat = formatDate(date, {
        locale: 'en-US',
        format: { dateStyle: 'short', timeZone: 'UTC' },
      });
      const viaTz = formatDate(date, {
        locale: 'en-US',
        format: { dateStyle: 'short' },
        tz: 'UTC',
      });

      expect(viaFormat).toBe(viaTz);
      expect(viaFormat).toContain('6/1/24');
    });
  });

  it('should apply different presets correctly', () => {
    const date = new Date('2024-01-01T12:00:00Z');

    TestBed.runInInjectionContext(() => {
      const dateOnly = formatDate(date, {
        locale: store.locale(),
        format: 'shortDate',
        tz: 'UTC',
      });
      const timeOnly = formatDate(date, {
        locale: store.locale(),
        format: 'shortTime',
        tz: 'UTC',
      });

      expect(dateOnly.length).toBeGreaterThan(0);
      expect(timeOnly.length).toBeGreaterThan(0);
      expect(dateOnly).not.toEqual(timeOnly);
    });
  });

  it('should use the provided defaults when using the inject version', () => {
    TestBed.runInInjectionContext(() => {
      const injector = inject(Injector);

      const withOverrides = Injector.create({
        parent: injector,
        providers: [
          provideFormatDateDefaults({
            format: 'short',
          }),
        ],
      });

      const fd = runInInjectionContext(withOverrides, () => injectFormatDate());
      const d = new Date();
      expect(fd(d)).toBe(
        formatDate(d, { format: 'short', locale: store.locale() }),
      );
    });
  });
});
