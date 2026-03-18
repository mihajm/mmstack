import { Component, Pipe, type PipeTransform } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMockTranslations } from './testing/provide-mock-translations';
import { Translator } from './translator';

// Mock compilation shape
type MockLocale = any;

@Pipe({
  name: 'translate',
  standalone: true,
})
class TestTranslatorPipe
  extends Translator<MockLocale>
  implements PipeTransform {}

@Component({
  standalone: true,
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
