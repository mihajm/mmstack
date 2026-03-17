import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createNamespace } from '../create-namespace';
import { registerNamespace } from '../register-namespace';
import { provideMockTranslations } from './provide-mock-translations';

// 1. Create a dummy namespace
const dummyNs = createNamespace('dummy', {
  hello: 'Hello World',
  greet: 'Hello {name}',
});

// 2. Register namespace
const { injectNamespaceT } = registerNamespace(
  () => Promise.resolve(dummyNs.translation),
  {}, // no other locales
);

// 3. Create a component that uses the function method
@Component({
  selector: 'mm-cmp',
  standalone: true,
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

      // Notice how formatMessage from mock currently doesn't process Intl variables,
      // it simply returns the raw mocked string. This is usually sufficient for unit tests.
      expect(el.querySelector('#fn-test')?.textContent).toBe('Mocked Hello');
      expect(el.querySelector('#fn-var-test')?.textContent).toBe(
        'Mocked Greet {name}',
      );
    });
  });
});
