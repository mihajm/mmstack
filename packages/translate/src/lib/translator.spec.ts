import { Component, Pipe, type PipeTransform } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMockTranslations } from './testing/provide-mock-translations';
import { injectDynamicLocale, TranslationStore } from './translation-store';
import { Translator } from './translator';

// Mock compilation shape
type MockLocale = any;

@Pipe({
  name: 'translate',
})
class TestTranslatorPipe
  extends Translator<MockLocale>
  implements PipeTransform {}

@Component({
  imports: [TestTranslatorPipe],
  template: `
    <div id="basic">{{ 'myNs::MMT_DELIM::hello' | translate }}</div>
    <div id="with-vars">
      {{ 'myNs::MMT_DELIM::greet' | translate: { name: 'John' } }}
    </div>
  `,
})
class TestComponent {}

describe('Translator Pipe', () => {
  let fixture: ComponentFixture<TestComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestComponent],
      providers: [
        provideMockTranslations({
          translations: {
            myNs: {
              hello: 'Hello World',
              greet: 'Hello {name}',
            },
          },
        }),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TestComponent);
  });

  it('should translate keys correctly without variables', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#basic')?.textContent).toBe('Hello World');
  });

  it('should translate keys correctly with variables', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#with-vars')?.textContent?.trim()).toBe(
      'Hello {name}',
    );
  });
});

@Pipe({
  name: 'translate',
})
class RealTranslatorPipe
  extends Translator<MockLocale>
  implements PipeTransform {}

@Component({
  imports: [RealTranslatorPipe],
  template: `
    <div id="basic">{{ 'myNs::MMT_DELIM::hello' | translate: loc() }}</div>
  `,
})
class LocaleSwitchComponent {
  protected readonly loc = injectDynamicLocale();
}

describe('Translator Pipe (locale switching)', () => {
  let fixture: ComponentFixture<LocaleSwitchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LocaleSwitchComponent],
      // No mock — use the real TranslationStore
    }).compileComponents();

    const store = TestBed.inject(TranslationStore);
    store.register('myNs', {
      'en-US': { hello: 'Hello World' },
    });

    fixture = TestBed.createComponent(LocaleSwitchComponent);
  });

  it('should update translation when locale changes', async () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#basic')?.textContent).toBe('Hello World');

    const store = TestBed.inject(TranslationStore);

    // Register a new locale's translations
    store.register('myNs', { 'sl-SI': { hello: 'Pozdravljen svet' } });

    // Change the locale
    store.locale.set('sl-SI');

    // Flush effects and re-render
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('#basic')?.textContent).toBe('Pozdravljen svet');
  });
});
