import { Component, computed, Directive, isSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField } from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { fieldMetadata } from '../metadata/field-metadata';
import {
  compose,
  composition,
  type FieldRef,
  injectField,
} from './compose';

const [withLabel, injectLabel] = fieldMetadata<string>({ debugName: 'label' });
const [withHint] = fieldMetadata<string>({ debugName: 'hint' });

// a raw projector returning a getter — reads validator-fed error state, lazily
const firstError = (f: FieldRef) => () =>
  f.state().errors()[0]?.message ?? '';

// reusable, named compositions (defined at module level — composition() is lazy)
const [textField, injectTextField] = composition({
  label: withLabel,
  hint: withHint,
  error: firstError,
});
// extend a composition by spreading the projectable record
const [, injectSelect] = composition({
  ...textField,
  invalid: (f: FieldRef) => () => f.state().invalid(),
});

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'input[formField]',
})
class Probe {
  readonly tf = injectTextField();
  readonly select = injectSelect();
  readonly solo = injectField(withLabel);
  readonly inline = compose({
    label: withLabel, // carrier (getter) → computed
    error: firstError, // getter → computed
    konst: () => 'K', // plain value → constant computed
    sig: (f: FieldRef) => computed(() => f.state().value()), // signal → as-is
    // same handle projected twice → proves a single injected ref
    ff1: (f: FieldRef) => f.formField,
    ff2: (f: FieldRef) => f.formField,
  });
}

@Component({
  imports: [FormField, Probe],
  template: `<input [formField]="f.name" />`,
})
class Host {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => {
    withLabel(p.name, 'L');
    withHint(p.name, 'H');
  });
}

function probe(): Probe {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.debugElement.query(By.directive(Probe)).injector.get(Probe);
}

describe('compose / composition', () => {
  it('materializes a composition reader into one object of signals', () => {
    const p = probe();
    expect(p.tf.label()).toBe('L');
    expect(p.tf.hint()).toBe('H');
    expect(p.tf.error()).toBe('');
  });

  it('normalizes value | getter | signal entries to signals', () => {
    const p = probe();
    for (const s of [p.inline.label, p.inline.error, p.inline.konst, p.inline.sig])
      expect(isSignal(s)).toBe(true);
    expect(p.inline.label()).toBe('L'); // carrier
    expect(p.inline.konst()).toBe('K'); // plain value
    expect(p.inline.sig()).toBe('x'); // signal passed through
  });

  it('injects the field once — projectors share one ref', () => {
    const p = probe();
    expect(p.inline.ff1()).toBe(p.inline.ff2());
  });

  it('extends a composition by spreading its projectable record', () => {
    const p = probe();
    expect(p.select.label()).toBe('L'); // carried over from textField
    expect(p.select.invalid()).toBe(false);
  });

  it('injectField materializes a single projectable', () => {
    const p = probe();
    expect(isSignal(p.solo)).toBe(true);
    expect(p.solo()).toBe('L');
  });

  it('throws when materialized outside a [formField] host', () => {
    expect(() =>
      TestBed.runInInjectionContext(() => compose({ label: withLabel })),
    ).toThrow(/must be used inside a control bound to a field/);
    expect(() =>
      TestBed.runInInjectionContext(() => injectField(withLabel)),
    ).toThrow(/must be used inside a control bound to a field/);
  });

  it('keeps injectLabel standalone behavior', () => {
    expect(typeof injectLabel).toBe('function');
  });
});
