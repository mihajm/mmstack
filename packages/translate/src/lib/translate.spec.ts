import { Component, Directive, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideMockTranslations } from './testing/provide-mock-translations';
import { Translate } from './translate';

@Directive({
  selector: '[translate]',
})
class TestTranslateDirective extends Translate<any, any> {}

@Component({
  imports: [TestTranslateDirective],
  template: `
    <div id="static-test" translate="myNs::MMT_DELIM::hello"></div>
    <div
      id="var-test"
      [translate]="['myNs::MMT_DELIM::greet', { name: name() }]"
    ></div>
    <div id="dynamic-key-test" [translate]="dynamicKey()"></div>
    <div
      id="full-test"
      [translate]="['myNs::MMT_DELIM::full', { first: 'A', last: last() }]"
    ></div>
    <div id="tuple-key-test" [translate]="[tupleKey(), { name: 'X' }]"></div>
  `,
})
class TestComponent {
  name = signal('John');
  last = signal('B');
  dynamicKey = signal('myNs::MMT_DELIM::hello');
  tupleKey = signal('myNs::MMT_DELIM::greet');
}

describe('Translate Directive', () => {
  let fixture: ComponentFixture<TestComponent>;
  let component: TestComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestComponent],
      providers: [
        provideMockTranslations({
          translations: {
            myNs: {
              hello: 'Hello World',
              greet: 'Hello {name}',
              goodbye: 'Goodbye',
              bye: 'Bye {name}',
              full: '{first} {last}',
            },
          },
          formatValues: true,
        }),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TestComponent);
    component = fixture.componentInstance;
  });

  it('should render translation text content for static keys', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#static-test')?.textContent).toBe('Hello World');
  });

  it('should render translation text content with variables', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#var-test')?.textContent).toBe('Hello John');
  });

  it('should respond to signal changes in variables', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#var-test')?.textContent).toBe('Hello John');

    component.name.set('Jane');
    fixture.detectChanges();
    TestBed.tick();

    expect(el.querySelector('#var-test')?.textContent).toBe('Hello Jane');
  });

  it('should respond to a change in one of several variables', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#full-test')?.textContent).toBe('A B');

    component.last.set('C');
    fixture.detectChanges();
    TestBed.tick();

    expect(el.querySelector('#full-test')?.textContent).toBe('A C');
  });

  it('should respond to a key change in a tuple with equal variables', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#tuple-key-test')?.textContent).toBe('Hello X');

    component.tupleKey.set('myNs::MMT_DELIM::bye');
    fixture.detectChanges();
    TestBed.tick();

    expect(el.querySelector('#tuple-key-test')?.textContent).toBe('Bye X');
  });

  it('should respond to signal changes in keys', () => {
    fixture.detectChanges();
    TestBed.tick();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#dynamic-key-test')?.textContent).toBe(
      'Hello World',
    );

    component.dynamicKey.set('myNs::MMT_DELIM::goodbye');
    fixture.detectChanges();
    TestBed.tick();

    expect(el.querySelector('#dynamic-key-test')?.textContent).toBe('Goodbye');
  });
});
