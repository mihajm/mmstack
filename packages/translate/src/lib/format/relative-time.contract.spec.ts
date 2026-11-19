import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatRelativeTime,
  formatRelativeTimeToNow,
  injectFormatRelativeTime,
  injectFormatRelativeTimeToNow,
  provideFormatRelativeTimeDefaults,
} from './relative-time';

const NOW = Date.UTC(2024, 0, 15, 12);
const ago = (seconds: number) => NOW - seconds * 1000;
const toNow = (seconds: number) =>
  formatRelativeTimeToNow(ago(seconds), { locale: 'en-US', now: NOW });

describe('formatRelativeTimeToNow unit selection at boundaries', () => {
  it.each([
    [59.6, '1 minute ago'],
    [59.4, '59 seconds ago'],
    [3599, '1 hour ago'],
    [86000, '1 day ago'],
    [6.6 * 86400, '1 week ago'],
    [14 * 86400, '2 weeks ago'],
    [60 * 86400, '2 months ago'],
    [11.7 * 30.44 * 86400, '1 year ago'],
  ])('%d seconds before now reads %s', (seconds, expected) => {
    expect(toNow(seconds)).toBe(expected);
  });

  it('rounds up to the next unit in the future as well', () => {
    expect(
      formatRelativeTimeToNow(NOW + 59_600, { locale: 'en-US', now: NOW }),
    ).toBe('in 1 minute');
  });
});

describe('formatRelativeTime options', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('honors an explicit style', () => {
    expect(
      formatRelativeTime(2, 'month', { locale: 'en-US', style: 'short' }),
    ).toBe('in 2 mo.');
  });

  it('the no-locale overload reads the active locale', () => {
    const store = TestBed.inject(TranslationStore);
    store.locale.set('de-DE');
    expect(formatRelativeTime(-1, 'day')).toBe('vor 1 Tag');
    store.locale.set('en-US');
  });
});

describe('injected relative time formatters', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('en-US');
  });

  it('per-call options and locales override the defaults', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatRelativeTime();
      expect(fmt(-1, 'day', { numeric: 'auto' })).toBe('yesterday');
      expect(fmt(2, 'month', 'de-DE')).toBe('in 2 Monaten');
      expect(fmt(-1, 'day')).toBe('1 day ago');
    });
  });

  it('toNow accepts a per-call locale', () => {
    vi.useFakeTimers({ now: NOW });
    try {
      TestBed.runInInjectionContext(() => {
        const fmt = injectFormatRelativeTimeToNow();
        expect(fmt(ago(3 * 86400), 'de-DE')).toBe('vor 3 Tagen');
        expect(fmt(ago(86400), { numeric: 'auto' })).toBe('yesterday');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('signal-provided defaults react to a numeric-only and a style-only change', () => {
    const cfg = signal<{
      numeric?: 'auto' | 'always';
      style?: 'long' | 'short';
    }>({ numeric: 'always', style: 'long' });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideFormatRelativeTimeDefaults(() => cfg)],
    });
    TestBed.inject(TranslationStore).locale.set('en-US');
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatRelativeTime();
      const day = computed(() => fmt(-1, 'day'));
      const months = computed(() => fmt(2, 'month'));
      expect(day()).toBe('1 day ago');
      cfg.set({ numeric: 'auto', style: 'long' });
      expect(day()).toBe('yesterday');
      expect(months()).toBe('in 2 months');
      cfg.set({ numeric: 'auto', style: 'short' });
      expect(months()).toBe('in 2 mo.');
    });
  });
});
