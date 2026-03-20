import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule, NgControl } from '@angular/forms';
import { SignalErrorValidator } from './signal-error-validator';
import { By } from '@angular/platform-browser';

@Component({
  standalone: true,
  imports: [FormsModule, SignalErrorValidator],
  template: `
    <input
      [(ngModel)]="value"
      [mmSignalError]="error()"
    />
  `,
})
class TestComponent {
  value = '';
  error = signal('');
}

describe('SignalErrorValidator', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestComponent],
    }).compileComponents();
  });

  it('should be valid when error signal is empty', async () => {
    const fixture = TestBed.createComponent(TestComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const input = fixture.debugElement.query(By.directive(SignalErrorValidator));
    const ngControl = input.injector.get(NgControl);

    expect(ngControl.errors).toBeNull();
    expect(ngControl.valid).toBe(true);
  });

  it('should report error when signal has value', async () => {
    const fixture = TestBed.createComponent(TestComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    component.error.set('Required field');
    fixture.detectChanges();
    await fixture.whenStable();

    const input = fixture.debugElement.query(By.directive(SignalErrorValidator));
    const ngControl = input.injector.get(NgControl);

    expect(ngControl.errors).toEqual({ error: 'Required field' });
    expect(ngControl.invalid).toBe(true);
  });

  it('should clear error when signal is cleared', async () => {
    const fixture = TestBed.createComponent(TestComponent);
    const component = fixture.componentInstance;
    component.error.set('Old error');
    fixture.detectChanges();
    await fixture.whenStable();

    const ngControl = fixture.debugElement.query(By.directive(SignalErrorValidator)).injector.get(NgControl);
    expect(ngControl.errors).toEqual({ error: 'Old error' });

    component.error.set('');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(ngControl.errors).toBeNull();
  });
});
