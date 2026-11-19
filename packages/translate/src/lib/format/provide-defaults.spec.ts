import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import { injectFormatNumber, provideFormatNumberDefaults } from './numeric';

function setup(provider: unknown) {
  TestBed.configureTestingModule({ providers: [provider as never] });
  const store = TestBed.inject(TranslationStore);
  store.locale.set('en-US');
  return store;
}

describe('provideFormat*Defaults input forms', () => {
  it('accepts a factory returning options', () => {
    setup(provideFormatNumberDefaults(() => ({ notation: 'compact' })));
    TestBed.runInInjectionContext(() => {
      expect(injectFormatNumber()(1234567)).toBe('1.2M');
    });
  });

  it('accepts a factory returning a signal and follows it and the locale', () => {
    const opts = signal<{ notation: 'compact' | 'standard' }>({
      notation: 'compact',
    });
    const store = setup(provideFormatNumberDefaults(() => opts));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatNumber();
      const label = computed(() => fmt(1234567));
      expect(label()).toBe('1.2M');
      opts.set({ notation: 'standard' });
      expect(label()).toBe('1,234,567');
      store.locale.set('de-DE');
      expect(label()).toBe('1.234.567');
    });
    store.locale.set('en-US');
  });

  it('per-call options merge into the provided defaults', () => {
    setup(provideFormatNumberDefaults({ useGrouping: false }));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatNumber();
      expect(fmt(12345.6, { maxFractionDigits: 0 })).toBe('12346');
      expect(fmt(12345.6, { useGrouping: undefined })).toBe('12345.6');
    });
  });
});
