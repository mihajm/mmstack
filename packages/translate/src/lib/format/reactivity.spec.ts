import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import { injectFormatDate } from './date';
import { injectFormatDisplayName } from './display-name';
import { injectFormatList } from './list';
import {
  injectFormatCurrency,
  injectFormatNumber,
  injectFormatPercent,
  injectFormatUnit,
} from './numeric';
import { injectSelectPlural, selectPluralCategory } from './plural-rules';
import {
  formatRelativeTimeToNow,
  injectFormatRelativeTime,
  injectFormatRelativeTimeToNow,
} from './relative-time';

/**
 * The library's headline feature: every injected formatter re-resolves when the
 * locale signal changes. One test per formatter, asserting through a `computed`
 * exactly the way templates consume them.
 */
describe('formatter locale reactivity', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  it('number output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatNumber();
      const label = computed(() => fmt(1234.5));

      expect(label()).toBe('1,234.5');
      store.locale.set('de-DE');
      expect(label()).toBe('1.234,5');
    });
  });

  it('percent output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatPercent();
      const label = computed(() => fmt(0.5));

      expect(label()).toBe('50%');
      store.locale.set('de-DE');
      // German separates with a space (regular/no-break varies by ICU version)
      expect(label()).toMatch(/^50\s%$/);
    });
  });

  it('currency output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatCurrency();
      const label = computed(() => fmt(1234.5, 'USD'));

      expect(label()).toBe('$1,234.50');
      store.locale.set('de-DE');
      expect(label()).toContain('1.234,50');
    });
  });

  it('unit output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatUnit();
      const label = computed(() => fmt(16, 'kilometer-per-hour'));

      expect(label()).toBe('16 km/h');
      store.locale.set('de-DE');
      expect(label()).toContain('km/h');
    });
  });

  it('date output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatDate();
      const date = new Date('2024-01-15T12:00:00Z');
      const label = computed(() => fmt(date, { tz: 'UTC', format: 'longDate' }));

      expect(label()).toContain('January');
      store.locale.set('de-DE');
      expect(label()).toContain('Januar');
    });
  });

  it('relative time output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatRelativeTime();
      const label = computed(() => fmt(3, 'day'));

      expect(label()).toBe('in 3 days');
      store.locale.set('de-DE');
      expect(label()).toBe('in 3 Tagen');
    });
  });

  it('list output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatList();
      const label = computed(() => fmt(['a', 'b', 'c']));

      expect(label()).toBe('a, b, and c');
      store.locale.set('de-DE');
      expect(label()).toBe('a, b und c');
    });
  });

  it('display name output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatDisplayName();
      const label = computed(() => fmt('US', 'region'));

      expect(label()).toBe('United States');
      store.locale.set('de-DE');
      expect(label()).toBe('Vereinigte Staaten');
    });
  });

  it('plural category switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const plural = injectSelectPlural();
      const category = computed(() => plural(2));

      expect(category()).toBe('other'); // en-US: 2 → other
      store.locale.set('sl-SI');
      expect(category()).toBe('two'); // Slovenian has a dual form
    });
  });

  it('relative-time-to-now output switches with the locale signal', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatRelativeTimeToNow();
      const now = new Date('2024-06-01T12:00:00Z');
      const threeDaysAgo = new Date('2024-05-29T12:00:00Z');
      const label = computed(() => fmt(threeDaysAgo, { now }));

      expect(label()).toBe('3 days ago');
      store.locale.set('de-DE');
      expect(label()).toBe('vor 3 Tagen');
    });
  });
});

describe('formatRelativeTimeToNow (unit selection)', () => {
  const now = new Date('2024-06-01T12:00:00Z');

  it('picks the largest fitting unit', () => {
    expect(
      formatRelativeTimeToNow(new Date('2024-06-01T11:59:30Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('30 seconds ago');
    expect(
      formatRelativeTimeToNow(new Date('2024-06-01T11:15:00Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('45 minutes ago');
    expect(
      formatRelativeTimeToNow(new Date('2024-06-01T07:00:00Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('5 hours ago');
    expect(
      formatRelativeTimeToNow(new Date('2024-05-29T12:00:00Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('3 days ago');
    expect(
      formatRelativeTimeToNow(new Date('2025-08-01T12:00:00Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('in 1 year');
  });

  it('formats future instants and supports numeric: auto', () => {
    expect(
      formatRelativeTimeToNow(new Date('2024-06-03T12:00:00Z'), {
        locale: 'en-US',
        now,
      }),
    ).toBe('in 2 days');
    expect(
      formatRelativeTimeToNow(new Date('2024-05-31T12:00:00Z'), {
        locale: 'en-US',
        now,
        numeric: 'auto',
      }),
    ).toBe('yesterday');
  });

  it('coerces invalid/nullish input to the empty string', () => {
    expect(formatRelativeTimeToNow(null, { locale: 'en-US', now })).toBe('');
    expect(
      formatRelativeTimeToNow('not-a-date', { locale: 'en-US', now }),
    ).toBe('');
  });
});

describe('selectPluralCategory', () => {
  it('selects cardinal categories per locale', () => {
    expect(selectPluralCategory(1, { locale: 'en-US' })).toBe('one');
    expect(selectPluralCategory(2, { locale: 'en-US' })).toBe('other');
    expect(selectPluralCategory(1, { locale: 'sl-SI' })).toBe('one');
    expect(selectPluralCategory(2, { locale: 'sl-SI' })).toBe('two');
    expect(selectPluralCategory(3, { locale: 'sl-SI' })).toBe('few');
  });

  it('supports ordinal rules', () => {
    expect(
      selectPluralCategory(2, { locale: 'en-US', type: 'ordinal' }),
    ).toBe('two'); // "2nd"
    expect(
      selectPluralCategory(3, { locale: 'en-US', type: 'ordinal' }),
    ).toBe('few'); // "3rd"
  });

  it('coerces invalid input to other', () => {
    expect(selectPluralCategory(null, { locale: 'en-US' })).toBe('other');
    expect(selectPluralCategory(Infinity, { locale: 'en-US' })).toBe('other');
  });
});
