import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatDate,
  injectFormatDate,
  provideFormatDateDefaults,
} from './date';

const d = new Date(Date.UTC(2024, 0, 1, 12));

type Style = 'short' | 'medium' | 'long' | 'full';
const styles: Style[] = ['short', 'medium', 'long', 'full'];

const presets: [string, Intl.DateTimeFormatOptions][] = styles.flatMap(
  (s): [string, Intl.DateTimeFormatOptions][] => [
    [s, { dateStyle: s, timeStyle: s }],
    [`${s}Date`, { dateStyle: s }],
    [`${s}Time`, { timeStyle: s }],
  ],
);

const intl = (
  locale: string,
  o: Intl.DateTimeFormatOptions,
  timeZone = 'UTC',
) => new Intl.DateTimeFormat(locale, { ...o, timeZone }).format(d);

describe('formatDate presets', () => {
  it.each(presets)(
    '%s maps to the matching Intl styles',
    (format, styleOpts) => {
      expect(
        formatDate(d, { locale: 'en-US', tz: 'UTC', format: format as never }),
      ).toBe(intl('en-US', styleOpts));
    },
  );

  it("defaults to 'medium' for the string-locale overload", () => {
    expect(formatDate(d, 'en-US')).toBe(formatDate(d, { locale: 'en-US' }));
    expect(formatDate(d, { locale: 'en-US', tz: 'UTC' })).toBe(
      intl('en-US', { dateStyle: 'medium', timeStyle: 'medium' }),
    );
  });

  it('caches custom format objects separately', () => {
    const base = { locale: 'en-US', tz: 'UTC' };
    expect(formatDate(d, { ...base, format: { year: 'numeric' } })).toBe(
      '2024',
    );
    expect(formatDate(d, { ...base, format: { month: 'long' } })).toBe(
      'January',
    );
  });

  it('applies the time zone, per zone', () => {
    const at = (tz: string) =>
      formatDate(d, { locale: 'en-US', tz, format: 'shortTime' });
    expect(at('Pacific/Kiritimati')).toBe(
      intl('en-US', { timeStyle: 'short' }, 'Pacific/Kiritimati'),
    );
    expect(at('Pacific/Pago_Pago')).toBe(
      intl('en-US', { timeStyle: 'short' }, 'Pacific/Pago_Pago'),
    );
    expect(at('Pacific/Kiritimati')).not.toBe(at('Pacific/Pago_Pago'));
  });
});

describe('formatDate locale resolution', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('en-US');
  });

  afterEach(() => TestBed.inject(TranslationStore).locale.set('en-US'));

  it('an explicit string locale wins over the active locale', () => {
    expect(formatDate(d, 'de-DE')).toBe(formatDate(d, { locale: 'de-DE' }));
    expect(formatDate(d, 'de-DE')).not.toBe(formatDate(d, 'en-US'));
  });

  it('the no-locale overload reads the active locale', () => {
    TestBed.inject(TranslationStore).locale.set('de-DE');
    expect(formatDate(d)).toBe(formatDate(d, { locale: 'de-DE' }));
  });

  it('the injected formatter accepts a per-call string locale', () => {
    TestBed.runInInjectionContext(() => {
      expect(injectFormatDate()(d, 'de-DE')).toBe(
        formatDate(d, { locale: 'de-DE' }),
      );
    });
  });
});

describe('signal-provided date defaults', () => {
  it('react to a time zone change and to a format change', () => {
    const cfg = signal<{ tz?: string; format?: never | object | string }>({
      tz: 'UTC',
      format: 'shortTime',
    });
    TestBed.configureTestingModule({
      providers: [provideFormatDateDefaults(() => cfg as never)],
    });
    TestBed.inject(TranslationStore).locale.set('en-US');
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatDate();
      const label = computed(() => fmt(d));
      expect(label()).toBe(intl('en-US', { timeStyle: 'short' }));
      cfg.set({ tz: 'Pacific/Kiritimati', format: 'shortTime' });
      expect(label()).toBe(
        intl('en-US', { timeStyle: 'short' }, 'Pacific/Kiritimati'),
      );
      cfg.set({ tz: 'Pacific/Kiritimati', format: { year: 'numeric' } });
      expect(label()).toBe('2024');
      cfg.set({ tz: 'Pacific/Kiritimati', format: { month: 'long' } });
      expect(label()).toBe('January');
    });
  });
});
