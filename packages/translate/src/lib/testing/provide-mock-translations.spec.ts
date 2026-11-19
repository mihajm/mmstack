import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createNamespace } from '../create-namespace';
import { registerNamespace } from '../register-namespace';
import {
  injectDynamicLocale,
  injectIntl,
  injectLocaleLoadState,
  TranslationStore,
} from '../translation-store';
import { provideMockTranslations } from './provide-mock-translations';

const dummyNs = createNamespace('dummy', {
  hello: 'Hello World',
  greet: 'Hello {name}',
});

const { injectNamespaceT } = registerNamespace(
  () => Promise.resolve(dummyNs.translation),
  {},
);

@Component({
  selector: 'mm-cmp',
  template: `
    <div id="fn-test">{{ t('dummy.hello') }}</div>
    <div id="fn-var-test">{{ t('dummy.greet', { name: 'Alice' }) }}</div>
  `,
})
class TestComponent {
  t = injectNamespaceT();
}

describe('provideMockTranslations', () => {
  describe('without explicit mock translations', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestComponent],
        providers: [provideMockTranslations()],
      }).compileComponents();
    });

    it('should echo back the flattened dot-notation keys', () => {
      const fixture = TestBed.createComponent(TestComponent);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('#fn-test')?.textContent).toBe('dummy.hello');
      expect(el.querySelector('#fn-var-test')?.textContent).toBe('dummy.greet');
    });
  });

  describe('with explicit mock translations', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestComponent],
        providers: [
          provideMockTranslations({
            translations: {
              dummy: {
                hello: 'Mocked Hello',
                greet: 'Mocked Greet {name}',
              },
            },
          }),
        ],
      }).compileComponents();
    });

    it('should return the mocked values', () => {
      const fixture = TestBed.createComponent(TestComponent);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('#fn-test')?.textContent).toBe('Mocked Hello');
      expect(el.querySelector('#fn-var-test')?.textContent?.trim()).toBe(
        'Mocked Greet {name}',
      );
    });
  });

  describe('with formatValues enabled', () => {
    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TestComponent],
        providers: [
          provideMockTranslations({
            translations: {
              dummy: {
                hello: 'Mocked Hello',
                greet: 'Hi {name}!',
              },
            },
            formatValues: true,
          }),
        ],
      }).compileComponents();
    });

    it('should interpolate ICU variables via @formatjs/intl', () => {
      const fixture = TestBed.createComponent(TestComponent);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('#fn-test')?.textContent).toBe('Mocked Hello');
      expect(el.querySelector('#fn-var-test')?.textContent?.trim()).toBe(
        'Hi Alice!',
      );
    });
  });
});

describe('provideMockTranslations store surface', () => {
  function setup(options?: Parameters<typeof provideMockTranslations>[0]) {
    TestBed.configureTestingModule({
      providers: [provideMockTranslations(options)],
    });
    return TestBed.runInInjectionContext(() => ({
      store: TestBed.inject(TranslationStore),
      locale: injectDynamicLocale(),
      loadState: injectLocaleLoadState(),
      intl: injectIntl(),
    }));
  }

  it("defaults the locale to 'en-US' and passes an override through", () => {
    expect(setup().store.locale()).toBe('en-US');
    TestBed.resetTestingModule();
    expect(setup({ locale: 'de-DE' }).store.locale()).toBe('de-DE');
  });

  it('injectDynamicLocale().set switches the mock locale', () => {
    const { locale, store } = setup();
    locale.set('de-DE');
    expect(locale()).toBe('de-DE');
    expect(store.locale()).toBe('de-DE');
  });

  it('reports an idle, non-loading locale loader', () => {
    const { locale, loadState } = setup();
    expect(locale.isLoading()).toBe(false);
    expect(loadState.isLoading()).toBe(false);
    expect(loadState.status()).toBe('idle');
    expect(loadState.hasValue()).toBe(false);
  });

  it('injectIntl returns an intl for the mock locale', () => {
    expect(setup().intl().locale).toBe('en-US');
    TestBed.resetTestingModule();
    expect(setup({ locale: 'de-DE' }).intl().locale).toBe('de-DE');
  });

  it('formatValues formats ICU arguments with the mock locale', () => {
    const { store } = setup({
      formatValues: true,
      locale: 'de-DE',
      translations: { ns: { n: '{n, number}' } },
    });
    expect(store.formatMessage('ns::MMT_DELIM::n', { n: 1234 })).toBe('1.234');
  });
});
