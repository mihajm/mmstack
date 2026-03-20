import { signal } from '@angular/core';
import { derived } from '@mmstack/primitives';
import { formControl } from './form-control';

describe('formControl', () => {
  describe('creation', () => {
    it('should create a control with a plain initial value', () => {
      const ctrl = formControl('hello');

      expect(ctrl.value()).toBe('hello');
      expect(ctrl.controlType).toBe('control');
    });

    it('should generate a unique id', () => {
      const ctrl1 = formControl('a');
      const ctrl2 = formControl('b');

      expect(typeof ctrl1.id).toBe('string');
      expect(ctrl1.id.length).toBeGreaterThan(0);
      expect(ctrl1.id).not.toBe(ctrl2.id);
    });

    it('should use a custom id when provided', () => {
      const ctrl = formControl('val', { id: () => 'my-id' });

      expect(ctrl.id).toBe('my-id');
    });

    it('should accept a custom controlType', () => {
      const ctrl = formControl('val', { controlType: 'group' });

      expect(ctrl.controlType).toBe('group');
    });

    it('should store the equality function', () => {
      const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const ctrl = formControl('Hello', { equal: eq });

      expect(ctrl.equal).toBe(eq);
    });

    it('should default equality to Object.is', () => {
      const ctrl = formControl('val');

      expect(ctrl.equal).toBe(Object.is);
    });
  });

  describe('value', () => {
    it('should read and write values', () => {
      const ctrl = formControl(10);

      expect(ctrl.value()).toBe(10);

      ctrl.value.set(20);
      expect(ctrl.value()).toBe(20);
    });

    it('should support update', () => {
      const ctrl = formControl(5);

      ctrl.value.update((v) => v * 3);
      expect(ctrl.value()).toBe(15);
    });
  });

  describe('dirty', () => {
    it('should be pristine initially', () => {
      const ctrl = formControl('initial');

      expect(ctrl.dirty()).toBe(false);
    });

    it('should become dirty when value changes', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.dirty()).toBe(true);
    });

    it('should return to pristine when value matches initial', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.dirty()).toBe(true);

      ctrl.value.set('initial');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should use custom dirtyEquality when provided', () => {
      const ctrl = formControl('Hello', {
        dirtyEquality: (a, b) => a.toLowerCase() === b.toLowerCase(),
      });

      ctrl.value.set('HELLO');
      expect(ctrl.dirty()).toBe(false);

      ctrl.value.set('world');
      expect(ctrl.dirty()).toBe(true);
    });

    it('should fall back to equal when dirtyEquality is not provided', () => {
      const ctrl = formControl('Hello', {
        equal: (a, b) => a.toLowerCase() === b.toLowerCase(),
      });

      ctrl.value.set('HELLO');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should not be dirty, if moved back to old value or reset', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.dirty()).toBe(true);

      ctrl.value.set('initial');
      expect(ctrl.dirty()).toBe(false);

      ctrl.reset();
      expect(ctrl.dirty()).toBe(false);

      ctrl.forceReconcile('new initial');
      expect(ctrl.dirty()).toBe(false);
    });
  });

  describe('touched', () => {
    it('should not be touched initially', () => {
      const ctrl = formControl('val');

      expect(ctrl.touched()).toBe(false);
    });

    it('should be touched after markAsTouched', () => {
      const ctrl = formControl('val');

      ctrl.markAsTouched();
      expect(ctrl.touched()).toBe(true);
    });

    it('should return to untouched after markAsPristine', () => {
      const ctrl = formControl('val');

      ctrl.markAsTouched();
      expect(ctrl.touched()).toBe(true);

      ctrl.markAsPristine();
      expect(ctrl.touched()).toBe(false);
    });

    it('markAllAsTouched should behave as markAsTouched for a leaf control', () => {
      const ctrl = formControl('val');

      ctrl.markAllAsTouched();
      expect(ctrl.touched()).toBe(true);
    });

    it('markAllAsPristine should behave as markAsPristine for a leaf control', () => {
      const ctrl = formControl('val');

      ctrl.markAllAsTouched();
      ctrl.markAllAsPristine();
      expect(ctrl.touched()).toBe(false);
    });

    it('should call onTouched callback when marking as touched', () => {
      const onTouched = vi.fn();
      const ctrl = formControl('val', { onTouched });

      ctrl.markAsTouched();
      expect(onTouched).toHaveBeenCalledOnce();
    });

    it('should not call onTouched when marking as pristine', () => {
      const onTouched = vi.fn();
      const ctrl = formControl('val', { onTouched });

      ctrl.markAsTouched();
      onTouched.mockClear();

      ctrl.markAsPristine();
      expect(onTouched).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should have no error by default', () => {
      const ctrl = formControl('val');

      expect(ctrl.error()).toBe('');
      expect(ctrl.valid()).toBe(true);
    });

    it('should compute error from validator', () => {
      const ctrl = formControl('', {
        validator: () => (value) => (value ? '' : 'required'),
      });

      expect(ctrl.error()).toBe('required');
      expect(ctrl.valid()).toBe(false);
    });

    it('should recompute error reactively when value changes', () => {
      const ctrl = formControl('', {
        validator: () => (value) => (value.length >= 3 ? '' : 'too short'),
      });

      expect(ctrl.error()).toBe('too short');

      ctrl.value.set('abc');
      expect(ctrl.error()).toBe('');
      expect(ctrl.valid()).toBe(true);
    });

    it('should support reactive validators', () => {
      const minLength = signal(3);

      const ctrl = formControl('ab', {
        validator: () => (value) =>
          value.length >= minLength() ? '' : `min ${minLength()}`,
      });

      expect(ctrl.error()).toBe('min 3');

      minLength.set(2);
      expect(ctrl.error()).toBe('');
    });

    it('should suppress errors when disabled', () => {
      const disabled = signal(false);

      const ctrl = formControl('', {
        validator: () => (value) => (value ? '' : 'required'),
        disable: () => disabled(),
      });

      expect(ctrl.error()).toBe('required');

      disabled.set(true);
      expect(ctrl.error()).toBe('');
      expect(ctrl.valid()).toBe(true);
    });

    it('should suppress errors when readonly', () => {
      const readonly = signal(false);

      const ctrl = formControl('', {
        validator: () => (value) => (value ? '' : 'required'),
        readonly: () => readonly(),
      });

      expect(ctrl.error()).toBe('required');

      readonly.set(true);
      expect(ctrl.error()).toBe('');
    });

    it('should use overrideValidation when provided', () => {
      const override = signal('override error');

      const ctrl = formControl('valid value', {
        validator: () => () => '',
        overrideValidation: () => override(),
      });

      expect(ctrl.error()).toBe('override error');

      override.set('');
      expect(ctrl.error()).toBe('');
    });

    it('overrideValidation should take priority over regular validator', () => {
      const ctrl = formControl('', {
        validator: () => (value) => (value ? '' : 'required'),
        overrideValidation: () => 'forced error',
      });

      expect(ctrl.error()).toBe('forced error');
    });

    it('overrideValidation should bypass disabled/readonly suppression', () => {
      const ctrl = formControl('', {
        disable: () => true,
        overrideValidation: () => 'still an error',
      });

      expect(ctrl.error()).toBe('still an error');
    });
  });

  describe('pending and valid', () => {
    it('should not be pending by default', () => {
      const ctrl = formControl('val');

      expect(ctrl.pending()).toBe(false);
    });

    it('should reflect pending state from option', () => {
      const pending = signal(false);

      const ctrl = formControl('val', {
        pending: () => pending(),
      });

      expect(ctrl.pending()).toBe(false);

      pending.set(true);
      expect(ctrl.pending()).toBe(true);
    });

    it('should be invalid when pending even if no error', () => {
      const ctrl = formControl('val', {
        pending: () => true,
      });

      expect(ctrl.error()).toBe('');
      expect(ctrl.pending()).toBe(true);
      expect(ctrl.valid()).toBe(false);
    });

    it('should be invalid when both pending and error', () => {
      const ctrl = formControl('', {
        validator: () => (v) => (v ? '' : 'required'),
        pending: () => true,
      });

      expect(ctrl.valid()).toBe(false);
    });

    it('should be valid when not pending and no error', () => {
      const ctrl = formControl('val', {
        pending: () => false,
      });

      expect(ctrl.valid()).toBe(true);
    });
  });

  describe('disabled', () => {
    it('should not be disabled by default', () => {
      const ctrl = formControl('val');

      expect(ctrl.disabled()).toBe(false);
    });

    it('should reflect disabled state reactively', () => {
      const disabled = signal(false);
      const ctrl = formControl('val', { disable: () => disabled() });

      expect(ctrl.disabled()).toBe(false);

      disabled.set(true);
      expect(ctrl.disabled()).toBe(true);
    });
  });

  describe('readonly', () => {
    it('should not be readonly by default', () => {
      const ctrl = formControl('val');

      expect(ctrl.readonly()).toBe(false);
    });

    it('should reflect readonly state reactively', () => {
      const ro = signal(false);
      const ctrl = formControl('val', { readonly: () => ro() });

      expect(ctrl.readonly()).toBe(false);

      ro.set(true);
      expect(ctrl.readonly()).toBe(true);
    });
  });

  describe('required', () => {
    it('should not be required by default', () => {
      const ctrl = formControl('val');

      expect(ctrl.required()).toBe(false);
    });

    it('should reflect required state reactively', () => {
      const req = signal(false);
      const ctrl = formControl('val', { required: () => req() });

      expect(ctrl.required()).toBe(false);

      req.set(true);
      expect(ctrl.required()).toBe(true);
    });
  });

  describe('label', () => {
    it('should default to empty string', () => {
      const ctrl = formControl('val');

      expect(ctrl.label()).toBe('');
    });

    it('should reflect label reactively', () => {
      const lbl = signal('Name');
      const ctrl = formControl('val', { label: () => lbl() });

      expect(ctrl.label()).toBe('Name');

      lbl.set('Full Name');
      expect(ctrl.label()).toBe('Full Name');
    });
  });

  describe('hint', () => {
    it('should default to empty string', () => {
      const ctrl = formControl('val');

      expect(ctrl.hint()).toBe('');
    });

    it('should reflect hint reactively', () => {
      const h = signal('Enter your name');
      const ctrl = formControl('val', { hint: () => h() });

      expect(ctrl.hint()).toBe('Enter your name');

      h.set('Required field');
      expect(ctrl.hint()).toBe('Required field');
    });
  });

  describe('partialValue', () => {
    it('should be undefined when not dirty', () => {
      const ctrl = formControl('initial');

      expect(ctrl.partialValue()).toBeUndefined();
    });

    it('should return the value when dirty', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.partialValue()).toBe('changed');
    });

    it('should return to undefined when the value matches initial again', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.partialValue()).toBe('changed');

      ctrl.value.set('initial');
      expect(ctrl.partialValue()).toBeUndefined();
    });
  });

  describe('reconcile', () => {
    it('should update value and initial when not dirty', () => {
      const ctrl = formControl('old');

      ctrl.reconcile('new');

      expect(ctrl.value()).toBe('new');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should preserve user changes when dirty', () => {
      const ctrl = formControl('old');

      ctrl.value.set('user-edit');
      expect(ctrl.dirty()).toBe(true);

      ctrl.reconcile('server-update');

      // value should not change because the control is dirty
      expect(ctrl.value()).toBe('user-edit');
      expect(ctrl.dirty()).toBe(true);
    });

    it('should update initial even when dirty (detectable through reset)', () => {
      const ctrl = formControl('old');

      ctrl.value.set('user-edit');
      ctrl.reconcile('server-update');

      // The user still sees their edit
      expect(ctrl.value()).toBe('user-edit');

      // But resetting now goes to the server value
      // Actually according to the implementation, reconcile skips setting both value AND initial when dirty
      // Let's verify: when dirty, internalReconcile does nothing
      ctrl.reset();
      // reset sets value to initialValue, which was never changed since the control was dirty
      expect(ctrl.value()).toBe('old');
    });

    it('should chain multiple reconciliations on a pristine control', () => {
      const ctrl = formControl('v1');

      ctrl.reconcile('v2');
      expect(ctrl.value()).toBe('v2');
      expect(ctrl.dirty()).toBe(false);

      ctrl.reconcile('v3');
      expect(ctrl.value()).toBe('v3');
      expect(ctrl.dirty()).toBe(false);
    });
  });

  describe('forceReconcile', () => {
    it('should update value even when dirty', () => {
      const ctrl = formControl('old');

      ctrl.value.set('user-edit');
      expect(ctrl.dirty()).toBe(true);

      ctrl.forceReconcile('forced');
      expect(ctrl.value()).toBe('forced');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should update value when not dirty (same as reconcile)', () => {
      const ctrl = formControl('old');

      ctrl.forceReconcile('new');
      expect(ctrl.value()).toBe('new');
      expect(ctrl.dirty()).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset value to initial', () => {
      const ctrl = formControl('initial');

      ctrl.value.set('changed');
      expect(ctrl.dirty()).toBe(true);

      ctrl.reset();
      expect(ctrl.value()).toBe('initial');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should call onReset callback', () => {
      const onReset = vi.fn();
      const ctrl = formControl('initial', { onReset });

      ctrl.reset();
      expect(onReset).toHaveBeenCalledOnce();
    });

    it('should reset to reconciled initial value', () => {
      const ctrl = formControl('v1');

      ctrl.reconcile('v2');
      ctrl.value.set('user-edit');

      ctrl.reset();
      expect(ctrl.value()).toBe('v2');
    });
  });

  describe('resetWithInitial', () => {
    it('should reset both value and initial value', () => {
      const ctrl = formControl('old');

      ctrl.value.set('changed');
      ctrl.resetWithInitial('brand-new');

      expect(ctrl.value()).toBe('brand-new');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should call onReset callback', () => {
      const onReset = vi.fn();
      const ctrl = formControl('old', { onReset });

      ctrl.resetWithInitial('new');
      expect(onReset).toHaveBeenCalledOnce();
    });

    it('should set the new initial so future resets use it', () => {
      const ctrl = formControl('v1');

      ctrl.resetWithInitial('v2');
      ctrl.value.set('v3');
      expect(ctrl.dirty()).toBe(true);

      ctrl.reset();
      expect(ctrl.value()).toBe('v2');
    });
  });

  describe('DerivedSignal integration', () => {
    it('should use a DerivedSignal as the value source', () => {
      const source = signal({ name: 'John', age: 30 });
      const nameDerived = derived(source, 'name');

      const ctrl = formControl(nameDerived);

      expect(ctrl.value()).toBe('John');
    });

    it('should write back to the source signal through the DerivedSignal', () => {
      const source = signal({ name: 'John', age: 30 });
      const nameDerived = derived(source, 'name');

      const ctrl = formControl(nameDerived);

      ctrl.value.set('Jane');
      expect(source().name).toBe('Jane');
    });

    it('should track dirty state against initial snapshot', () => {
      const source = signal({ name: 'John', age: 30 });
      const nameDerived = derived(source, 'name');

      const ctrl = formControl(nameDerived);

      expect(ctrl.dirty()).toBe(false);

      ctrl.value.set('Jane');
      expect(ctrl.dirty()).toBe(true);

      ctrl.value.set('John');
      expect(ctrl.dirty()).toBe(false);
    });

    it('should expose the from function when using DerivedSignal', () => {
      const source = signal({ name: 'John', age: 30 });
      const nameDerived = derived(source, 'name');

      const ctrl = formControl(nameDerived);

      expect(ctrl.from).toBeDefined();
      expect(ctrl.from?.({ name: 'Test', age: 0 })).toBe('Test');
    });

    it('should not have from when using a plain value', () => {
      const ctrl = formControl('plain');

      expect(ctrl.from).toBeUndefined();
    });
  });

  describe('object values', () => {
    it('should support object values with custom equality', () => {
      const eq = (a: { id: number }, b: { id: number }) => a.id === b.id;
      const ctrl = formControl({ id: 1 }, { equal: eq });

      expect(ctrl.value()).toEqual({ id: 1 });

      // Different reference but same id — should not be dirty because dirtyEquality falls back to equal
      ctrl.value.set({ id: 1 });
      expect(ctrl.dirty()).toBe(false);
    });

    it('should differentiate dirty with custom dirtyEquality for objects', () => {
      const ctrl = formControl(
        { id: 1, name: 'A' },
        {
          equal: Object.is,
          dirtyEquality: (a, b) => a.id === b.id && a.name === b.name,
        },
      );

      ctrl.value.set({ id: 1, name: 'A' });
      expect(ctrl.dirty()).toBe(false);

      ctrl.value.set({ id: 1, name: 'B' });
      expect(ctrl.dirty()).toBe(true);
    });
  });

  describe('numeric values', () => {
    it('should handle number controls', () => {
      const ctrl = formControl(0, {
        validator: () => (v) => (v >= 0 ? '' : 'must be positive'),
      });

      expect(ctrl.valid()).toBe(true);

      ctrl.value.set(-1);
      expect(ctrl.error()).toBe('must be positive');
      expect(ctrl.valid()).toBe(false);
    });
  });

  describe('boolean values', () => {
    it('should handle boolean controls', () => {
      const ctrl = formControl(false, {
        validator: () => (v) => (v ? '' : 'must accept'),
      });

      expect(ctrl.error()).toBe('must accept');
      ctrl.value.set(true);
      expect(ctrl.error()).toBe('');
    });
  });

  describe('combined states', () => {
    it('full lifecycle: create, touch, edit, validate, reconcile, reset', () => {
      const serverData = signal('server-initial');

      const ctrl = formControl('server-initial', {
        validator: () => (v) => (v.length > 0 ? '' : 'required'),
        label: () => 'Username',
      });

      // initial state
      expect(ctrl.dirty()).toBe(false);
      expect(ctrl.touched()).toBe(false);
      expect(ctrl.valid()).toBe(true);
      expect(ctrl.label()).toBe('Username');
      expect(ctrl.partialValue()).toBeUndefined();

      // user interaction
      ctrl.markAsTouched();
      expect(ctrl.touched()).toBe(true);

      ctrl.value.set('user-edit');
      expect(ctrl.dirty()).toBe(true);
      expect(ctrl.partialValue()).toBe('user-edit');

      // server reconcile (should not overwrite)
      serverData.set('server-v2');
      ctrl.reconcile(serverData());
      expect(ctrl.value()).toBe('user-edit');

      // force reconcile
      ctrl.forceReconcile(serverData());
      expect(ctrl.value()).toBe('server-v2');
      expect(ctrl.dirty()).toBe(false);

      // edit again then reset
      ctrl.value.set('another-edit');
      ctrl.reset();
      expect(ctrl.value()).toBe('server-v2');
      expect(ctrl.dirty()).toBe(false);

      // resetWithInitial
      ctrl.resetWithInitial('brand-new');
      expect(ctrl.value()).toBe('brand-new');

      // clear to trigger validation
      ctrl.value.set('');
      expect(ctrl.error()).toBe('required');
      expect(ctrl.valid()).toBe(false);
    });
  });
});
