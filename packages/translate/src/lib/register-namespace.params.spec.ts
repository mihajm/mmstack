import { computed, signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { addSignalFn, createT, injectUnsafeT } from './register-namespace';
import { injectLocaleInternal, TranslationStore } from './translation-store';

type AsSignal = (
  key: string,
  params?: () => Record<string, string | number>,
) => Signal<string>;

function setupStore() {
  TestBed.configureTestingModule({});
  TestBed.runInInjectionContext(() => injectLocaleInternal().set('en-US'));
  const store = TestBed.inject(TranslationStore);
  store.register('p', {
    'en-US': { two: 'x {a} {b}', opt: 'name: {name}', plain: 'plain' },
  });
  return store;
}

const variants: [string, () => AsSignal][] = [
  [
    'registered t.asSignal',
    () => {
      const store = setupStore();
      const t = addSignalFn(createT(store), store, new Map());
      return t.asSignal as unknown as AsSignal;
    },
  ],
  [
    'injectUnsafeT().asSignal',
    () => {
      setupStore();
      return TestBed.runInInjectionContext(() => injectUnsafeT()).asSignal;
    },
  ],
];

describe.each(variants)('%s params factory', (_, make) => {
  it('updates when only a later param changes', () => {
    const asSignal = make();
    const a = signal('1');
    const b = signal('1');
    const sig = asSignal('p.two', () => ({ a: a(), b: b() }));
    expect(sig()).toBe('x 1 1');
    b.set('2');
    expect(sig()).toBe('x 1 2');
  });

  it('updates when every param changes at once', () => {
    const asSignal = make();
    const a = signal('1');
    const b = signal('1');
    const sig = asSignal('p.two', () => ({ a: a(), b: b() }));
    expect(sig()).toBe('x 1 1');
    a.set('2');
    b.set('3');
    expect(sig()).toBe('x 2 3');
  });

  it('updates when the factory adds keys it did not return at first', () => {
    const asSignal = make();
    const show = signal(false);
    const name = signal('Ann');
    const sig = asSignal('p.opt', () =>
      show() ? { name: name() } : ({} as Record<string, string>),
    );
    sig();
    show.set(true);
    expect(sig()).toBe('name: Ann');
    name.set('Bob');
    expect(sig()).toBe('name: Bob');
  });

  it('does not make a reactive caller depend on the params', () => {
    const asSignal = make();
    const a = signal('1');
    let runs = 0;
    const outer = computed(() => {
      runs++;
      return asSignal('p.two', () => ({ a: a(), b: 'b' }));
    });
    expect(outer()()).toBe('x 1 b');
    a.set('2');
    expect(outer()()).toBe('x 2 b');
    expect(runs).toBe(1);
  });
});
