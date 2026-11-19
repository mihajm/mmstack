import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslationStore } from '../translation-store';
import {
  injectFormatCurrency,
  injectFormatNumber,
  injectFormatPercent,
  injectFormatUnit,
  provideFormatCurrencyDefaults,
  provideFormatNumberDefaults,
  provideFormatPercentDefaults,
  provideFormatUnitDefaults,
} from './numeric';

const n = (s: string) => s.replace(/\s/g, ' ');

function setup(provider: unknown) {
  TestBed.configureTestingModule({ providers: [provider as never] });
  const store = TestBed.inject(TranslationStore);
  store.locale.set('en-US');
  return store;
}

type Step<T> = [Partial<T>, string];

// Each step changes one field of the current defaults, so a field whose change is
// missed leaves the label stale.
function walk<T>(
  defs: ReturnType<typeof signal<Partial<T>>>,
  label: () => string,
  start: string,
  steps: Step<T>[],
) {
  expect(n(label())).toBe(start);
  for (const [patch, expected] of steps) {
    defs.update((cur) => ({ ...cur, ...patch }));
    expect(n(label())).toBe(expected);
  }
}

describe('signal-provided numeric defaults react to each field', () => {
  it('number', () => {
    type O = Parameters<ReturnType<typeof injectFormatNumber>>[1] & object;
    const defs = signal<Partial<O>>({});
    setup(provideFormatNumberDefaults(() => defs as never));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatNumber();
      const x = signal<number | null>(2.5);
      const label = computed(() => fmt(x()));
      walk<O>(defs, label, '2.5', [
        [{ minFractionDigits: 2 }, '2.50'],
        [{ minFractionDigits: undefined }, '2.5'],
        [{ maxFractionDigits: 0 }, '3'],
        [{ roundingMode: 'floor' }, '2'],
        [{ maxFractionDigits: undefined }, '2.5'],
        [{ signDisplay: 'exceptZero' }, '+2.5'],
      ]);
      x.set(1000);
      walk<O>(defs, label, '+1,000', [
        [{ useGrouping: false }, '+1000'],
        [{ notation: 'compact' }, '+1K'],
      ]);
      x.set(null);
      walk<O>(defs, label, '', [[{ fallbackToZero: true }, '0']]);
    });
  });

  it('percent', () => {
    type O = Parameters<ReturnType<typeof injectFormatPercent>>[1] & object;
    const defs = signal<Partial<O>>({});
    setup(provideFormatPercentDefaults(() => defs as never));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatPercent();
      const x = signal<number | null>(0.1234);
      const label = computed(() => fmt(x()));
      walk<O>(defs, label, '12%', [
        [{ minFractionDigits: 1 }, '12.3%'],
        [{ maxFractionDigits: 2 }, '12.34%'],
      ]);
      x.set(null);
      walk<O>(defs, label, '', [[{ fallbackToZero: true }, '0.0%']]);
    });
  });

  it('currency', () => {
    type O = Parameters<ReturnType<typeof injectFormatCurrency>>[2] & object;
    const defs = signal<Partial<O>>({});
    setup(provideFormatCurrencyDefaults(() => defs as never));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatCurrency();
      const x = signal<number | null>(2.5);
      const label = computed(() => fmt(x(), 'USD'));
      walk<O>(defs, label, '$2.50', [
        [{ display: 'code' }, 'USD 2.50'],
        [{ display: 'symbol' }, '$2.50'],
        [{ minFractionDigits: 3 }, '$2.500'],
        [{ minFractionDigits: undefined }, '$2.50'],
        [{ maxFractionDigits: 0 }, '$3'],
        [{ roundingMode: 'floor' }, '$2'],
        [{ signDisplay: 'exceptZero' }, '+$2'],
      ]);
      x.set(null);
      walk<O>(defs, label, '', [[{ fallbackToZero: true }, '$0']]);
    });
  });

  it('unit', () => {
    type O = Parameters<ReturnType<typeof injectFormatUnit>>[2] & object;
    const defs = signal<Partial<O>>({});
    setup(provideFormatUnitDefaults(() => defs as never));
    TestBed.runInInjectionContext(() => {
      const fmt = injectFormatUnit();
      const x = signal<number | null>(2.5);
      const label = computed(() => fmt(x(), 'liter'));
      walk<O>(defs, label, '2.5 L', [
        [{ unitDisplay: 'long' }, '2.5 liters'],
        [{ unitDisplay: 'short' }, '2.5 L'],
        [{ minFractionDigits: 2 }, '2.50 L'],
        [{ minFractionDigits: undefined }, '2.5 L'],
        [{ maxFractionDigits: 0 }, '3 L'],
        [{ roundingMode: 'floor' }, '2 L'],
        [{ maxFractionDigits: undefined }, '2.5 L'],
        [{ signDisplay: 'exceptZero' }, '+2.5 L'],
      ]);
      x.set(1000);
      walk<O>(defs, label, '+1,000 L', [[{ useGrouping: false }, '+1000 L']]);
      x.set(null);
      walk<O>(defs, label, '', [[{ fallbackToZero: true }, '0 L']]);
    });
  });
});
