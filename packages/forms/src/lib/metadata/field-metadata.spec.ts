import { Component, Directive, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  form,
  FormField,
  metadata,
  type MetadataReducer,
} from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { fromMetadata, injectField } from '../compose/compose';
import { fieldMetadata } from './field-metadata';

// Module-level attribute definitions (mirrors real usage: defined once, used everywhere).
const [withLabel, injectLabel, LABEL] = fieldMetadata<string>({
  debugName: 'label',
});
const [, injectBaseLabel, BASE_LABEL] = fieldMetadata<string>({
  debugName: 'baseLabel',
  fallback: 'BASE',
});

const [withNullable, injectNullable] = fieldMetadata<string | null>({
  debugName: 'nullable',
  fallback: 'FALLBACK',
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
  readonly nullable = injectNullable();
  // The exposed key, read raw via the native layer — no fallbacks apply here.
  readonly rawBaseLabel = injectField(fromMetadata(BASE_LABEL));
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
  template: ` <input [formField]="f.name" /> `,
})
class SchemaHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => {
    withLabel(p.name, 'SCHEMA');
    withNullable(p.name, null);
  });
}

@Component({
  imports: [FormField, Probe],
  template: ` <input [formField]="f.name" /> `,
})
class BareHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model);
}

@Component({
  imports: [FormField, Probe],
  template: ` <input [formField]="f.name" /> `,
})
class ReactiveHost {
  readonly model = signal({ name: 'ann' });
  readonly f = form(this.model, (p) =>
    withLabel(p.name, ({ value }) => value().toUpperCase()),
  );
}

@Component({
  imports: [FormField, Probe],
  template: ` <input [formField]="f.name" /> `,
})
class ReducerHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => {
    withLongest(p.name, 'aa');
    withLongest(p.name, 'bbbb');
    withLongest(p.name, 'c');
  });
}

// The escape hatch: the attribute set through the NATIVE metadata() rule with the exposed key.
@Component({
  imports: [FormField, Probe],
  template: ` <input [formField]="f.name" /> `,
})
class NativeKeyHost {
  readonly model = signal({ name: 'x' });
  readonly f = form(this.model, (p) => {
    metadata(p.name, LABEL, () => 'NATIVE');
  });
}

// Decoupled paths: a string attribute on a NUMBER field, with the LogicFn ctx typed by the field.
@Component({
  imports: [FormField, Probe],
  template: ` <input [formField]="f.age" type="number" /> `,
})
class NumberPathHost {
  readonly model = signal({ age: 41 });
  readonly f = form(this.model, (p) => {
    withLabel(p.age, ({ value }) => `Age: ${value().toFixed(0)}`);
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

    it('treats a schema-set null as a real value — only undefined is unset', () => {
      const { probe } = setup(SchemaHost);
      expect(probe.nullable()).toBeNull(); // not 'FALLBACK'
      expect(setup(BareHost).probe.nullable()).toBe('FALLBACK');
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
      expect(() => TestBed.runInInjectionContext(() => injectLabel())).toThrow(
        /must be used inside a control bound to a field/,
      );
    });
  });

  describe('the exposed key (third tuple element)', () => {
    it('a value set through the native metadata() rule is read by the reader', () => {
      const { probe } = setup(NativeKeyHost);
      expect(probe.label()).toBe('NATIVE');
    });

    it('reads raw: no fallback applies at the key level', () => {
      const { probe } = setup(BareHost);
      expect(probe.rawBaseLabel()).toBeUndefined(); // the key sees only what schemas wrote
      expect(probe.baseLabel()).toBe('BASE'); // the reader applies the base fallback
    });
  });

  describe('decoupled paths', () => {
    it('attaches to a field of a different value type, with the LogicFn ctx typed by the field', () => {
      const { instance, probe } = setup(NumberPathHost);
      expect(probe.label()).toBe('Age: 41'); // `value()` is number-typed — toFixed compiles

      instance.model.set({ age: 42 });
      expect(probe.label()).toBe('Age: 42');
    });
  });
});
