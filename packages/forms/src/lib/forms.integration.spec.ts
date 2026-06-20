import { Component, model, signal } from '@angular/core';
import {
  form,
  FormField,
  type FormValueControl,
} from '@angular/forms/signals';
import { fireEvent, render, screen } from '@testing-library/angular';
import { changeTracking, commitChanges, trackChanges } from './changed';
import { composition } from './compose';
import { fieldMetadata } from './metadata';

// A field type assembled from the public pieces: a label attribute + change tracking (changed + reset).
const [withLabel, injectLabel] = fieldMetadata<string>({ debugName: 'label' });
const [, injectText] = composition({ ...changeTracking<string>() });

// A real custom control (FormValueControl) — the intended way to consume the library.
@Component({
  selector: 'mm-text-field',
  template: `
    <label>
      {{ label() }}
      <input #i [value]="value()" (input)="value.set(i.value)" />
    </label>
    <span data-testid="status">{{ field.changed() ? 'changed' : 'pristine' }}</span>
    <button type="button" data-testid="reset" (click)="field.reset()">
      reset
    </button>
  `,
})
class TextFieldControl implements FormValueControl<string> {
  readonly value = model.required<string>();
  protected readonly label = injectLabel('');
  protected readonly field = injectText();
}

@Component({
  selector: 'mm-host',
  imports: [TextFieldControl, FormField],
  template: `<mm-text-field [formField]="f.name" />`,
})
class Host {
  readonly model = signal({ name: 'ann' });
  readonly f = form(this.model, (p) => {
    withLabel(p.name, 'Full name');
    trackChanges(this.model)(p);
  });
  constructor() {
    commitChanges(this.f);
  }
}

describe('forms integration (real render)', () => {
  it('renders metadata, tracks edits, and resets through a real [formField] control', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const input = screen.getByRole('textbox') as HTMLInputElement;

    // initial: label projected, value bound, pristine
    expect(screen.getByText('Full name')).toBeTruthy();
    expect(input.value).toBe('ann');
    expect(screen.getByTestId('status').textContent?.trim()).toBe('pristine');

    // edit: typing flows control -> field -> model, and `changed` flips
    fireEvent.input(input, { target: { value: 'bob' } });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.model().name).toBe('bob');
    expect(screen.getByTestId('status').textContent?.trim()).toBe('changed');

    // reset: reverts value + baseline, DOM reflects it
    fireEvent.click(screen.getByTestId('reset'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.model().name).toBe('ann');
    expect(input.value).toBe('ann');
    expect(screen.getByTestId('status').textContent?.trim()).toBe('pristine');
  });
});
