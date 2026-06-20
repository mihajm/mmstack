import { Component, Directive, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { form, FormField, type MetadataReducer } from '@angular/forms/signals';
import { fieldMetadata } from './field-metadata';

// Module-level attribute definitions (mirrors real usage: defined once, used everywhere).
const [withLabel, injectLabel] = fieldMetadata<string>({ debugName: 'label' });
const [, injectBaseLabel] = fieldMetadata<string>({
  debugName: 'baseLabel',
  fallback: 'BASE',
});

// A custom same-type reducer that keeps the longest contributed string.
const longest: MetadataReducer<string | undefined, string> = {
  getInitial: () => undefined,
  reduce: (acc, item) => (!acc || item.length > acc.length ? item : acc),
};
const [withLongest, injectLongest] = fieldMetadata<string>({
  debugName: 'longest',
  reducer: longest,
});

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'input[formField]',
})
class Probe {
  readonly label = injectLabel();
  readonly labelOrComponent = injectLabel('COMPONENT');
  readonly baseLabel = injectBaseLabel();
  readonly baseLabelOrComponent = injectBaseLabel('OVERRIDE');
  readonly longest = injectLongest();
}

function setup<C>(type: new () => C): { instance: C; probe: Probe } {
  const fixture = TestBed.createComponent(type);
  fixture.detectChanges();
  const probe = fixture.debugElement
    .query(By.directive(Probe))
    .injector.get(Probe);
  return { instance: fixture.componentInstance, probe };
}

@Component({
  imports: [FormField, Probe],
  template: `<input [formField]="f.name" />`,
})
class SchemaHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => withLabel(p.name, 'SCHEMA'));
}

@Component({
  imports: [FormField, Probe],
  template: `<input [formField]="f.name" />`,
})
class BareHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model);
}

@Component({
  imports: [FormField, Probe],
  template: `<input [formField]="f.name" />`,
})
class ReactiveHost {
  readonly model = signal({ name: 'ann' });
  readonly f = form(this.model, (p) =>
    withLabel(p.name, ({ value }) => value().toUpperCase()),
  );
}

@Component({
  imports: [FormField, Probe],
  template: `<input [formField]="f.name" />`,
})
class ReducerHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => {
    withLongest(p.name, 'aa');
    withLongest(p.name, 'bbbb');
    withLongest(p.name, 'c');
  });
}

describe('fieldMetadata', () => {
  describe('precedence', () => {
    it('uses the schema value over any fallback', () => {
      const { probe } = setup(SchemaHost);
      expect(probe.label()).toBe('SCHEMA');
      expect(probe.labelOrComponent()).toBe('SCHEMA');
    });

    it('falls back to undefined when unset and no fallback is given', () => {
      const { probe } = setup(BareHost);
      expect(probe.label()).toBeUndefined();
    });

    it('uses the component fallback when the schema did not set a value', () => {
      const { probe } = setup(BareHost);
      expect(probe.labelOrComponent()).toBe('COMPONENT');
    });

    it('uses the base fallback when unset, and lets the component override it', () => {
      const { probe } = setup(BareHost);
      expect(probe.baseLabel()).toBe('BASE');
      expect(probe.baseLabelOrComponent()).toBe('OVERRIDE');
    });
  });

  describe('reactivity', () => {
    it('tracks a reactive LogicFn value', () => {
      const { instance, probe } = setup(ReactiveHost);
      expect(probe.label()).toBe('ANN');

      instance.model.set({ name: 'bob' });
      expect(probe.label()).toBe('BOB');
    });
  });

  describe('reducer', () => {
    it('merges multiple rule contributions via a custom reducer', () => {
      const { probe } = setup(ReducerHost);
      expect(probe.longest()).toBe('bbbb');
    });
  });

  describe('no host', () => {
    it('throws when read outside a [formField] host', () => {
      expect(() =>
        TestBed.runInInjectionContext(() => injectLabel()),
      ).toThrow(/must be used inside a control bound to a field/);
    });
  });
});
