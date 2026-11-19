import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  formatDisplayName,
  injectFormatDisplayName,
  provideFormatDisplayNameDefaults,
} from './display-name';
import {
  formatList,
  injectFormatList,
  provideFormatListDefaults,
} from './list';
import {
  injectSelectPlural,
  provideSelectPluralDefaults,
  selectPluralCategory,
} from './plural-rules';

function setup(providers: unknown[] = []) {
  TestBed.configureTestingModule({ providers: providers as never[] });
  const store = TestBed.inject(TranslationStore);
  store.locale.set('en-US');
  return store;
}

afterEach(() => TestBed.inject(TranslationStore).locale.set('en-US'));

describe('formatDisplayName', () => {
  beforeEach(() => setup());

  it('trims padded codes', () => {
    expect(formatDisplayName(' US ', 'region', 'en-US')).toBe('United States');
  });

  it('returns an empty string for a malformed code', () => {
    expect(formatDisplayName('not a code!', 'region', 'en-US')).toBe('');
  });

  it('an explicit string locale wins over the active locale', () => {
    expect(formatDisplayName('US', 'region', 'de-DE')).toBe(
      'Vereinigte Staaten',
    );
  });

  it('the no-locale overload reads the active locale', () => {
    TestBed.inject(TranslationStore).locale.set('de-DE');
    expect(formatDisplayName('US', 'region')).toBe('Vereinigte Staaten');
  });

  it('the injected formatter accepts a per-call string locale', () => {
    TestBed.runInInjectionContext(() => {
      expect(injectFormatDisplayName()('US', 'region', 'de-DE')).toBe(
        'Vereinigte Staaten',
      );
    });
  });
});

describe('signal-provided display name defaults', () => {
  it('react to a style change', () => {
    const cfg = signal<{ style: 'long' | 'short' }>({ style: 'long' });
    setup([provideFormatDisplayNameDefaults(() => cfg)]);
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatDisplayName();
      const label = computed(() => fmt('GB', 'region'));
      expect(label()).toBe('United Kingdom');
      cfg.set({ style: 'short' });
      expect(label()).toBe('UK');
    });
  });
});

describe('formatList', () => {
  beforeEach(() => setup());

  it('the no-locale overload reads the active locale', () => {
    TestBed.inject(TranslationStore).locale.set('de-DE');
    expect(formatList(['a', 'b'])).toBe('a und b');
  });

  it('the injected formatter takes per-call options and locales', () => {
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatList();
      expect(fmt(['a', 'b'], { type: 'disjunction' })).toBe('a or b');
      expect(fmt(['a', 'b'], 'de-DE')).toBe('a und b');
      expect(fmt(['a', 'b'])).toBe('a and b');
    });
  });

  it('signal-provided defaults react to a type-only and a style-only change', () => {
    TestBed.resetTestingModule();
    const cfg = signal<{
      type: 'conjunction' | 'disjunction';
      style: 'long' | 'short';
    }>({ type: 'conjunction', style: 'long' });
    setup([provideFormatListDefaults(() => cfg)]);
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatList();
      const label = computed(() => fmt(['a', 'b', 'c']));
      expect(label()).toBe('a, b, and c');
      cfg.set({ type: 'disjunction', style: 'long' });
      expect(label()).toBe('a, b, or c');
      cfg.set({ type: 'conjunction', style: 'short' });
      expect(label()).toBe('a, b, & c');
    });
  });
});

describe('selectPluralCategory', () => {
  beforeEach(() => setup());

  it("nullish input selects 'other' even where 0 has its own category", () => {
    expect(selectPluralCategory(null, { locale: 'fr-FR' })).toBe('other');
    expect(selectPluralCategory(undefined, { locale: 'lv' })).toBe('other');
  });

  it('the injected selector takes per-call options and locales', () => {
    TestBed.runInInjectionContext(() => {
      const plural = injectSelectPlural();
      expect(plural(2, { type: 'ordinal' })).toBe('two');
      expect(plural(2, 'sl-SI')).toBe('two');
      expect(plural(2)).toBe('other');
    });
  });

  it('signal-provided defaults react to a type change', () => {
    TestBed.resetTestingModule();
    const cfg = signal<{ type: 'cardinal' | 'ordinal' }>({ type: 'cardinal' });
    setup([provideSelectPluralDefaults(() => cfg)]);
    TestBed.runInInjectionContext(() => {
      const plural = injectSelectPlural();
      const cat = computed(() => plural(2));
      expect(cat()).toBe('other');
      cfg.set({ type: 'ordinal' });
      expect(cat()).toBe('two');
    });
  });
});
