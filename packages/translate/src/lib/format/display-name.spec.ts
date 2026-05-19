import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import { formatDisplayName } from './display-name';

describe('formatDisplayName', () => {
  let store: TranslationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(TranslationStore);
    store.locale.set('en-US');
  });

  it('should format a display name for a language region', () => {
    TestBed.runInInjectionContext(() => {
      const result = formatDisplayName('US', 'region', {
        locale: store.locale(),
      });
      expect(result).toBe('United States');
    });
  });

  it('should accept signals for value, type, and options', () => {
    const valSignal = signal('GB');
    const typeSignal = signal<Intl.DisplayNamesType>('region');
    const optSignal = signal({
      style: 'short' as const,
      locale: store.locale(),
    });

    TestBed.runInInjectionContext(() => {
      const result = formatDisplayName(valSignal, typeSignal, optSignal);
      // short region for GB in en-US is usually "UK"
      expect(result).toBe('UK');
    });
  });

  it('should return empty string for null, undefined, or empty code', () => {
    TestBed.runInInjectionContext(() => {
      expect(
        formatDisplayName(null, 'region', { locale: store.locale() }),
      ).toBe('');
      expect(
        formatDisplayName(undefined, 'region', { locale: store.locale() }),
      ).toBe('');
      expect(
        formatDisplayName('   ', 'region', { locale: store.locale() }),
      ).toBe('');
    });
  });

  it('should respect the provided locale', () => {
    TestBed.runInInjectionContext(() => {
      const result = formatDisplayName('US', 'region', {
        locale: 'fr-FR',
        style: 'long',
      });
      expect(result).toBe('États-Unis');
    });
  });
});
