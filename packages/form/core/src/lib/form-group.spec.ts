import { signal } from '@angular/core';
import { derived } from '@mmstack/primitives';
import { formControl } from './form-control';
import { formGroup } from './form-group';

type User = { name: string; age: number };

function createUserForm(initial: User = { name: 'John', age: 30 }) {
  const source = signal(initial);
  const group = formGroup(source, {
    name: formControl(derived(source, 'name')),
    age: formControl(derived(source, 'age')),
  });
  return { source, group };
}

describe('formGroup', () => {
  describe('creation', () => {
    it('should create a group with controlType "group"', () => {
      const { group } = createUserForm();

      expect(group.controlType).toBe('group');
    });

    it('should expose the source value', () => {
      const { group } = createUserForm();

      expect(group.value()).toEqual({ name: 'John', age: 30 });
    });

    it('should expose children', () => {
      const { group } = createUserForm();
      const children = group.children();

      expect(children.name.value()).toBe('John');
      expect(children.age.value()).toBe(30);
    });

    it('should accept a plain object as initial', () => {
      const group = formGroup({ name: 'Jane', age: 25 }, {});

      expect(group.value()).toEqual({ name: 'Jane', age: 25 });
      expect(group.controlType).toBe('group');
    });

    it('should accept a WritableSignal as initial', () => {
      const src = signal({ name: 'Bob', age: 40 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name')),
      });

      expect(group.value()).toEqual({ name: 'Bob', age: 40 });
    });

    it('should accept dynamic children via function', () => {
      const src = signal({ name: 'Alice', age: 20 });
      const group = formGroup(src, () => ({
        name: formControl(derived(src, 'name')),
        age: formControl(derived(src, 'age')),
      }));

      expect(group.children().name.value()).toBe('Alice');
      expect(group.children().age.value()).toBe(20);
    });
  });

  describe('dirty', () => {
    it('should not be dirty initially', () => {
      const { group } = createUserForm();

      expect(group.dirty()).toBe(false);
    });

    it('should become dirty when a child value changes', () => {
      const { group } = createUserForm();

      group.children().name.value.set('Jane');
      expect(group.dirty()).toBe(true);
    });

    it('should return to pristine when child value is restored', () => {
      const { group } = createUserForm();

      group.children().name.value.set('Jane');
      expect(group.dirty()).toBe(true);

      group.children().name.value.set('John');
      expect(group.dirty()).toBe(false);
    });

    it('should be dirty if any child is dirty', () => {
      const { group } = createUserForm();

      group.children().age.value.set(99);
      expect(group.dirty()).toBe(true);

      // name is still pristine
      expect(group.children().name.dirty()).toBe(false);
    });

    it('should not rely on object reference equality by default', () => {
      const { group } = createUserForm();

      // The group value signal holds the same object reference
      // but dirty should only be driven by children
      expect(group.dirty()).toBe(false);
    });
  });

  describe('touched', () => {
    it('should not be touched initially', () => {
      const { group } = createUserForm();

      expect(group.touched()).toBe(false);
    });

    it('should be touched if the group itself is touched', () => {
      const { group } = createUserForm();

      group.markAsTouched();
      expect(group.touched()).toBe(true);
    });

    it('should be touched if any child is touched', () => {
      const { group } = createUserForm();

      group.children().name.markAsTouched();
      expect(group.touched()).toBe(true);
    });

    it('markAllAsTouched should touch the group and all children', () => {
      const { group } = createUserForm();

      group.markAllAsTouched();

      expect(group.touched()).toBe(true);
      expect(group.children().name.touched()).toBe(true);
      expect(group.children().age.touched()).toBe(true);
    });

    it('markAllAsPristine should reset touched on group and all children', () => {
      const { group } = createUserForm();

      group.markAllAsTouched();
      group.markAllAsPristine();

      expect(group.touched()).toBe(false);
      expect(group.children().name.touched()).toBe(false);
      expect(group.children().age.touched()).toBe(false);
    });
  });

  describe('validation', () => {
    it('should have no error when group and children are valid', () => {
      const { group } = createUserForm();

      expect(group.error()).toBe('');
      expect(group.ownError()).toBe('');
      expect(group.valid()).toBe(true);
    });

    it('should show "INVALID" when a child has an error', () => {
      const src = signal({ name: '', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          validator: () => (v) => (v ? '' : 'required'),
          label: () => 'Name',
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.error()).toBe('INVALID');
      expect(group.valid()).toBe(false);
    });

    it('ownError should reflect only the group-level validator', () => {
      const src = signal({ name: '', age: 30 });
      const group = formGroup(
        src,
        {
          name: formControl(derived(src, 'name'), {
            validator: () => (v) => (v ? '' : 'name required'),
          }),
          age: formControl(derived(src, 'age')),
        },
        {
          validator: () => (v) =>
            v.age >= 18 ? '' : 'must be at least 18',
        },
      );

      // child has an error, but ownError only looks at group-level
      expect(group.ownError()).toBe('');
      // overall error: ownError is empty so it falls through to child errors -> 'INVALID'
      expect(group.error()).toBe('INVALID');
    });

    it('ownError should take priority over child errors', () => {
      const src = signal({ name: '', age: 10 });
      const group = formGroup(
        src,
        {
          name: formControl(derived(src, 'name'), {
            validator: () => (v) => (v ? '' : 'required'),
          }),
          age: formControl(derived(src, 'age')),
        },
        {
          validator: () => (v) =>
            v.age >= 18 ? '' : 'must be at least 18',
        },
      );

      // group-level error takes priority
      expect(group.ownError()).toBe('must be at least 18');
      expect(group.error()).toBe('must be at least 18');
    });

    it('should become valid when child errors are resolved', () => {
      const src = signal({ name: '', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          validator: () => (v) => (v ? '' : 'required'),
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.valid()).toBe(false);

      group.children().name.value.set('Alice');
      expect(group.valid()).toBe(true);
      expect(group.error()).toBe('');
    });
  });

  describe('disabled', () => {
    it('should not be disabled by default', () => {
      const { group } = createUserForm();

      expect(group.disabled()).toBe(false);
    });

    it('should be disabled via group option', () => {
      const disabled = signal(false);
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(
        src,
        {
          name: formControl(derived(src, 'name')),
        },
        { disable: () => disabled() },
      );

      expect(group.disabled()).toBe(false);

      disabled.set(true);
      expect(group.disabled()).toBe(true);
    });

    it('should be disabled when ALL children are disabled', () => {
      const childDisabled = signal(true);
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          disable: () => childDisabled(),
        }),
        age: formControl(derived(src, 'age'), {
          disable: () => childDisabled(),
        }),
      });

      expect(group.disabled()).toBe(true);

      childDisabled.set(false);
      expect(group.disabled()).toBe(false);
    });

    it('should NOT be disabled when only some children are disabled', () => {
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          disable: () => true,
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.disabled()).toBe(false);
    });
  });

  describe('readonly', () => {
    it('should not be readonly by default', () => {
      const { group } = createUserForm();

      expect(group.readonly()).toBe(false);
    });

    it('should be readonly via group option', () => {
      const ro = signal(false);
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(
        src,
        { name: formControl(derived(src, 'name')) },
        { readonly: () => ro() },
      );

      expect(group.readonly()).toBe(false);

      ro.set(true);
      expect(group.readonly()).toBe(true);
    });

    it('should be readonly when ALL children are readonly', () => {
      const childRo = signal(true);
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          readonly: () => childRo(),
        }),
        age: formControl(derived(src, 'age'), {
          readonly: () => childRo(),
        }),
      });

      expect(group.readonly()).toBe(true);

      childRo.set(false);
      expect(group.readonly()).toBe(false);
    });

    it('should NOT be readonly when only some children are readonly', () => {
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          readonly: () => true,
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.readonly()).toBe(false);
    });
  });

  describe('pending and valid', () => {
    it('should not be pending by default', () => {
      const { group } = createUserForm();

      expect(group.pending()).toBe(false);
    });

    it('should be pending when group-level pending is set', () => {
      const src = signal({ name: 'A', age: 1 });
      const pending = signal(false);
      const group = formGroup(
        src,
        { name: formControl(derived(src, 'name')) },
        { pending: () => pending() },
      );

      expect(group.pending()).toBe(false);

      pending.set(true);
      expect(group.pending()).toBe(true);
    });

    it('should be pending when any child is pending', () => {
      const childPending = signal(false);
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          pending: () => childPending(),
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.pending()).toBe(false);

      childPending.set(true);
      expect(group.pending()).toBe(true);
    });

    it('should be invalid when pending even if no errors', () => {
      const src = signal({ name: 'A', age: 1 });
      const group = formGroup(
        src,
        { name: formControl(derived(src, 'name')) },
        { pending: () => true },
      );

      expect(group.valid()).toBe(false);
    });

    it('should be invalid when any child is invalid', () => {
      const src = signal({ name: '', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          validator: () => (v) => (v ? '' : 'required'),
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.valid()).toBe(false);
    });

    it('should be valid when all children are valid and not pending', () => {
      const src = signal({ name: 'Alice', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          validator: () => (v) => (v ? '' : 'required'),
        }),
        age: formControl(derived(src, 'age')),
      });

      expect(group.valid()).toBe(true);
    });
  });

  describe('reconcile', () => {
    it('should update children and group value when not dirty', () => {
      const { group } = createUserForm();

      group.reconcile({ name: 'Jane', age: 25 });

      expect(group.children().name.value()).toBe('Jane');
      expect(group.children().age.value()).toBe(25);
      expect(group.dirty()).toBe(false);
    });

    it('should preserve dirty child values', () => {
      const { group } = createUserForm();

      group.children().name.value.set('user-edit');
      expect(group.children().name.dirty()).toBe(true);

      group.reconcile({ name: 'server-name', age: 25 });

      // dirty child keeps its value
      expect(group.children().name.value()).toBe('user-edit');
      // pristine child gets updated
      expect(group.children().age.value()).toBe(25);
    });

    it('should use mergeIfObject for the group value', () => {
      const { group } = createUserForm();

      // reconcile merges using mergeIfObject(newValue, currentValue)
      group.reconcile({ name: 'Jane', age: 25 });
      expect(group.value()).toEqual({ name: 'Jane', age: 25 });
    });
  });

  describe('forceReconcile', () => {
    it('should update all children even when dirty', () => {
      const { group } = createUserForm();

      group.children().name.value.set('user-edit');
      group.children().age.value.set(99);

      group.forceReconcile({ name: 'forced-name', age: 42 });

      expect(group.children().name.value()).toBe('forced-name');
      expect(group.children().age.value()).toBe(42);
      expect(group.dirty()).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all children and the group to initial values', () => {
      const { group } = createUserForm();

      group.children().name.value.set('edited');
      group.children().age.value.set(99);

      group.reset();

      expect(group.children().name.value()).toBe('John');
      expect(group.children().age.value()).toBe(30);
      expect(group.dirty()).toBe(false);
    });

    it('should reset to reconciled initial value', () => {
      const { group } = createUserForm();

      group.reconcile({ name: 'Server', age: 50 });
      group.children().name.value.set('user-edit');

      group.reset();

      expect(group.children().name.value()).toBe('Server');
      expect(group.children().age.value()).toBe(50);
    });
  });

  describe('resetWithInitial', () => {
    it('should reset group and children with a new initial value', () => {
      const { group } = createUserForm();

      group.children().name.value.set('edited');

      group.resetWithInitial({ name: 'NewInitial', age: 99 });

      expect(group.children().name.value()).toBe('NewInitial');
      expect(group.children().age.value()).toBe(99);
      expect(group.dirty()).toBe(false);
    });

    it('should set the new initial so future resets use it', () => {
      const { group } = createUserForm();

      group.resetWithInitial({ name: 'Base', age: 10 });
      group.children().name.value.set('EditAgain');

      group.reset();

      expect(group.children().name.value()).toBe('Base');
      expect(group.children().age.value()).toBe(10);
    });
  });

  describe('partialValue', () => {
    it('should return empty object when not dirty', () => {
      const { group } = createUserForm();

      expect(group.partialValue()).toEqual({});
    });

    it('should include only dirty children in partial value', () => {
      const { group } = createUserForm();

      group.children().name.value.set('edited');

      const pv = group.partialValue();
      expect(pv).toEqual({ name: 'edited' });
      expect((pv as any).age).toBeUndefined();
    });

    it('should include all dirty children', () => {
      const { group } = createUserForm();

      group.children().name.value.set('edited');
      group.children().age.value.set(99);

      expect(group.partialValue()).toEqual({ name: 'edited', age: 99 });
    });

    it('should use createBasePartialValue when provided', () => {
      const src = signal({ name: 'John', age: 30 });
      const group = formGroup(
        src,
        {
          name: formControl(derived(src, 'name')),
        },
        {
          createBasePartialValue: (v) => ({ name: v.name }) as any,
        },
      );

      // base partial value is always included, even when not dirty
      expect((group.partialValue() as any).name).toBe('John');
    });
  });

  describe('nested groups', () => {
    type Address = { street: string; city: string };
    type Person = { name: string; address: Address };

    function createNestedForm() {
      const src = signal<Person>({
        name: 'Alice',
        address: { street: '123 Main', city: 'Springfield' },
      });

      const addressDerived = derived(src, 'address');

      const group = formGroup(src, {
        name: formControl(derived(src, 'name')),
        address: formGroup(addressDerived, {
          street: formControl(derived(addressDerived, 'street')),
          city: formControl(derived(addressDerived, 'city')),
        }),
      });

      return { src, group };
    }

    it('should support nested groups', () => {
      const { group } = createNestedForm();

      expect(group.children().name.value()).toBe('Alice');
      expect(group.children().address.children().street.value()).toBe(
        '123 Main',
      );
      expect(group.children().address.children().city.value()).toBe(
        'Springfield',
      );
    });

    it('should propagate dirty from deeply nested children', () => {
      const { group } = createNestedForm();

      expect(group.dirty()).toBe(false);

      group.children().address.children().street.value.set('456 Oak');

      expect(group.children().address.dirty()).toBe(true);
      expect(group.dirty()).toBe(true);
    });

    it('should propagate touched from deeply nested children', () => {
      const { group } = createNestedForm();

      group.children().address.children().city.markAsTouched();

      expect(group.children().address.touched()).toBe(true);
      expect(group.touched()).toBe(true);
    });

    it('markAllAsTouched should cascade to all descendants', () => {
      const { group } = createNestedForm();

      group.markAllAsTouched();

      expect(group.children().name.touched()).toBe(true);
      expect(group.children().address.touched()).toBe(true);
      expect(group.children().address.children().street.touched()).toBe(true);
      expect(group.children().address.children().city.touched()).toBe(true);
    });

    it('markAllAsPristine should cascade to all descendants', () => {
      const { group } = createNestedForm();

      group.markAllAsTouched();
      group.markAllAsPristine();

      expect(group.touched()).toBe(false);
      expect(group.children().name.touched()).toBe(false);
      expect(group.children().address.children().street.touched()).toBe(false);
    });

    it('should propagate validation from nested groups', () => {
      const src = signal<Person>({
        name: 'Alice',
        address: { street: '', city: 'Springfield' },
      });

      const addressDerived = derived(src, 'address');

      const group = formGroup(src, {
        name: formControl(derived(src, 'name')),
        address: formGroup(addressDerived, {
          street: formControl(derived(addressDerived, 'street'), {
            validator: () => (v) => (v ? '' : 'street required'),
          }),
          city: formControl(derived(addressDerived, 'city')),
        }),
      });

      expect(group.valid()).toBe(false);
      expect(group.children().address.valid()).toBe(false);
      expect(group.error()).toBe('INVALID');
    });

    it('should reconcile nested structures', () => {
      const { group } = createNestedForm();

      group.reconcile({
        name: 'Bob',
        address: { street: '789 Elm', city: 'Shelbyville' },
      });

      expect(group.children().name.value()).toBe('Bob');
      expect(group.children().address.children().street.value()).toBe(
        '789 Elm',
      );
      expect(group.children().address.children().city.value()).toBe(
        'Shelbyville',
      );
      expect(group.dirty()).toBe(false);
    });

    it('should reset nested structures to initial values', () => {
      const { group } = createNestedForm();

      group.children().name.value.set('Modified');
      group.children().address.children().street.value.set('Modified St');

      group.reset();

      expect(group.children().name.value()).toBe('Alice');
      expect(group.children().address.children().street.value()).toBe(
        '123 Main',
      );
    });

    it('should resetWithInitial nested structures', () => {
      const { group } = createNestedForm();

      group.resetWithInitial({
        name: 'Charlie',
        address: { street: '999 Pine', city: 'Capital' },
      });

      expect(group.children().name.value()).toBe('Charlie');
      expect(group.children().address.children().street.value()).toBe(
        '999 Pine',
      );
      expect(group.children().address.children().city.value()).toBe('Capital');
      expect(group.dirty()).toBe(false);
    });

    it('should build nested partialValue', () => {
      const { group } = createNestedForm();

      group.children().address.children().street.value.set('Changed St');

      const pv = group.partialValue() as any;
      expect(pv.address).toBeDefined();
      expect(pv.name).toBeUndefined();
    });
  });

  describe('two-way binding with source signal', () => {
    it('should write child changes back to source signal', () => {
      const { source, group } = createUserForm();

      group.children().name.value.set('Jane');

      expect(source().name).toBe('Jane');
    });

    it('should reflect source signal changes in children', () => {
      const src = signal({ name: 'John', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name')),
        age: formControl(derived(src, 'age')),
      });

      src.set({ name: 'Jane', age: 25 });

      expect(group.children().name.value()).toBe('Jane');
      expect(group.children().age.value()).toBe(25);
    });
  });

  describe('combined lifecycle', () => {
    it('full lifecycle: create, touch, edit, validate, reconcile, reset', () => {
      const src = signal({ name: 'John', age: 30 });
      const group = formGroup(src, {
        name: formControl(derived(src, 'name'), {
          validator: () => (v) => (v ? '' : 'required'),
          label: () => 'Name',
        }),
        age: formControl(derived(src, 'age'), {
          validator: () => (v) => (v >= 0 ? '' : 'must be positive'),
          label: () => 'Age',
        }),
      });

      // initial state
      expect(group.dirty()).toBe(false);
      expect(group.touched()).toBe(false);
      expect(group.valid()).toBe(true);
      expect(group.partialValue()).toEqual({});

      // user interaction
      group.markAllAsTouched();
      expect(group.touched()).toBe(true);
      expect(group.children().name.touched()).toBe(true);

      group.children().name.value.set('');
      expect(group.dirty()).toBe(true);
      expect(group.valid()).toBe(false);
      expect(group.error()).toBe('INVALID');

      // fix validation
      group.children().name.value.set('Jane');
      expect(group.valid()).toBe(true);
      expect(group.partialValue()).toEqual({ name: 'Jane' });

      // server reconcile (preserves dirty child)
      group.reconcile({ name: 'ServerName', age: 40 });
      expect(group.children().name.value()).toBe('Jane');
      expect(group.children().age.value()).toBe(40);

      // force reconcile
      group.forceReconcile({ name: 'Forced', age: 50 });
      expect(group.children().name.value()).toBe('Forced');
      expect(group.children().age.value()).toBe(50);
      expect(group.dirty()).toBe(false);

      // edit and reset
      group.children().age.value.set(-1);
      expect(group.valid()).toBe(false);

      group.reset();
      expect(group.children().age.value()).toBe(50);
      expect(group.valid()).toBe(true);

      // resetWithInitial
      group.resetWithInitial({ name: 'Final', age: 99 });
      expect(group.value()).toEqual({ name: 'Final', age: 99 });
      expect(group.dirty()).toBe(false);
    });
  });
});
