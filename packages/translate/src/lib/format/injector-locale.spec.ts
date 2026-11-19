import { TestBed } from '@angular/core/testing';
import { injectLocaleInternal, TranslationStore } from '../translation-store';
import { formatDate, injectFormatDate } from './date';
import { injectFormatDisplayName } from './display-name';
import { injectFormatList } from './list';
import {
  injectFormatCurrency,
  injectFormatNumber,
  injectFormatPercent,
  injectFormatUnit,
} from './numeric';
import { injectSelectPlural } from './plural-rules';
import {
  injectFormatRelativeTime,
  injectFormatRelativeTimeToNow,
} from './relative-time';

const n = (s: string) => s.replace(/\s/g, ' ');

// The process-level locale moves away from this injector's locale, as another SSR request would.
describe('injected formatters use the injector locale, not the process-level one', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(TranslationStore).locale.set('de-DE');
    TestBed.runInInjectionContext(() => injectLocaleInternal().set('en-US'));
  });

  afterEach(() => TestBed.inject(TranslationStore).locale.set('en-US'));

  it('numeric formatters', () => {
    TestBed.runInInjectionContext(() => {
      expect(injectFormatNumber()(1234.5)).toBe('1.234,5');
      expect(n(injectFormatPercent()(0.5))).toBe('50 %');
      expect(n(injectFormatCurrency()(1234.5, 'EUR'))).toBe('1.234,50 €');
      expect(injectFormatUnit()(1234.5, 'kilometer-per-hour')).toBe(
        '1.234,5 km/h',
      );
    });
  });

  it('date, display name, list and plural', () => {
    const d = new Date(Date.UTC(2024, 0, 1, 12));
    TestBed.runInInjectionContext(() => {
      expect(injectFormatDate()(d)).toBe(formatDate(d, { locale: 'de-DE' }));
      expect(injectFormatDisplayName()('US', 'region')).toBe(
        'Vereinigte Staaten',
      );
      expect(injectFormatList()(['a', 'b'])).toBe('a und b');
      expect(injectSelectPlural()(2)).toBe('other');
    });
  });

  it('relative time formatters', () => {
    TestBed.runInInjectionContext(() => {
      expect(injectFormatRelativeTime()(-1, 'day')).toBe('vor 1 Tag');
      expect(injectFormatRelativeTimeToNow()(Date.now() - 3 * 86_400_000)).toBe(
        'vor 3 Tagen',
      );
    });
  });
});
