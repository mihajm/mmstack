import { signal } from '@angular/core';
import { derived, type DerivedSignal } from '@mmstack/primitives';
import { formArray } from './form-array';
import { formControl } from './form-control';
import { formGroup } from './form-group';

const simpleFactory = (val: DerivedSignal<string[], string>) =>
  formControl(val);

function createStringArray(initial: string[] = ['a', 'b', 'c']) {
  return formArray(initial, simpleFactory);
}

describe('formArray', () => {
  describe('creation', () => {
    it('should create an array with controlType "array"', () => {
      const arr = createStringArray();

      expect(arr.controlType).toBe('array');
    });

    it('should expose the source value', () => {
      const arr = createStringArray();

      expect(arr.value()).toEqual(['a', 'b', 'c']);
    });

    it('should create children for each element', () => {
      const arr = createStringArray();

      expect(arr.children().length).toBe(3);
      expect(arr.children()[0].value()).toBe('a');
      expect(arr.children()[1].value()).toBe('b');
      expect(arr.children()[2].value()).toBe('c');
    });

    it('should create an empty array', () => {
      const arr = formArray<string>([], simpleFactory);

      expect(arr.value()).toEqual([]);
      expect(arr.children().length).toBe(0);
    });

    it('should accept a DerivedSignal as initial', () => {
      const parent = signal({ items: ['x', 'y'] });
      const itemsDerived = derived(parent, 'items');
      const arr = formArray(itemsDerived, simpleFactory);

      expect(arr.value()).toEqual(['x', 'y']);
      expect(arr.children().length).toBe(2);
    });
  });

  describe('push and remove', () => {
    it('should add an element with push', () => {
      const arr = createStringArray();

      arr.push('d');

      expect(arr.value()).toEqual(['a', 'b', 'c', 'd']);
      expect(arr.children().length).toBe(4);
      expect(arr.children()[3].value()).toBe('d');
    });

    it('should remove an element by index', () => {
      const arr = createStringArray();

      arr.remove(1);

      expect(arr.value()).toEqual(['a', 'c']);
      expect(arr.children().length).toBe(2);
    });

    it('should remove first element', () => {
      const arr = createStringArray();

      arr.remove(0);

      expect(arr.value()).toEqual(['b', 'c']);
      expect(arr.children().length).toBe(2);
    });

    it('should remove last element', () => {
      const arr = createStringArray();

      arr.remove(2);

      expect(arr.value()).toEqual(['a', 'b']);
      expect(arr.children().length).toBe(2);
    });

    it('should handle push then remove', () => {
      const arr = createStringArray();

      arr.push('d');
      arr.remove(0);

      expect(arr.value()).toEqual(['b', 'c', 'd']);
      expect(arr.children().length).toBe(3);
    });

    it('should reuse existing controls when length changes', () => {
      const arr = createStringArray();
      const firstChildId = arr.children()[0].id;
      const secondChildId = arr.children()[1].id;

      arr.push('d');

      // existing controls should be reused
      expect(arr.children()[0].id).toBe(firstChildId);
      expect(arr.children()[1].id).toBe(secondChildId);
    });
  });

  describe('children reconciliation', () => {
    it('should create new controls only for added elements', () => {
      const arr = createStringArray(['a', 'b']);
      const ids = arr.children().map((c) => c.id);

      arr.push('c');

      // original controls preserved
      expect(arr.children()[0].id).toBe(ids[0]);
      expect(arr.children()[1].id).toBe(ids[1]);
      // new control created
      expect(arr.children().length).toBe(3);
    });

    it('should truncate controls when elements are removed via value set', () => {
      const arr = createStringArray(['a', 'b', 'c']);

      arr.value.set(['a']);

      expect(arr.children().length).toBe(1);
    });

    it('should not recreate children when length stays the same', () => {
      const arr = createStringArray(['a', 'b']);
      const ids = arr.children().map((c) => c.id);

      // change values but keep same length
      arr.value.set(['x', 'y']);

      expect(arr.children()[0].id).toBe(ids[0]);
      expect(arr.children()[1].id).toBe(ids[1]);
      expect(arr.children()[0].value()).toBe('x');
      expect(arr.children()[1].value()).toBe('y');
    });
  });

  describe('dirty', () => {
    it('should not be dirty initially', () => {
      const arr = createStringArray();

      expect(arr.dirty()).toBe(false);
    });

    it('should become dirty when a child value changes', () => {
      const arr = createStringArray();

      arr.children()[0].value.set('changed');
      expect(arr.dirty()).toBe(true);
    });

    it('should become dirty when array length changes (push)', () => {
      const arr = createStringArray();

      arr.push('d');
      expect(arr.dirty()).toBe(true);
    });

    it('should become dirty when array length changes (remove)', () => {
      const arr = createStringArray();

      arr.remove(0);
      expect(arr.dirty()).toBe(true);
    });

    it('should return to pristine when child value is restored', () => {
      const arr = createStringArray();

      arr.children()[1].value.set('changed');
      expect(arr.dirty()).toBe(true);

      arr.children()[1].value.set('b');
      expect(arr.dirty()).toBe(false);
    });
  });

  describe('touched', () => {
    it('should not be touched initially', () => {
      const arr = createStringArray();

      expect(arr.touched()).toBe(false);
    });

    it('should be touched if the array itself is touched', () => {
      const arr = createStringArray();

      arr.markAsTouched();
      expect(arr.touched()).toBe(true);
    });

    it('should be touched if any child is touched', () => {
      const arr = createStringArray();

      arr.children()[1].markAsTouched();
      expect(arr.touched()).toBe(true);
    });

    it('markAllAsTouched should touch array and all children', () => {
      const arr = createStringArray();

      arr.markAllAsTouched();

      expect(arr.touched()).toBe(true);
      arr.children().forEach((c) => expect(c.touched()).toBe(true));
    });

    it('markAllAsPristine should reset touched on array and all children', () => {
      const arr = createStringArray();

      arr.markAllAsTouched();
      arr.markAllAsPristine();

      expect(arr.touched()).toBe(false);
      arr.children().forEach((c) => expect(c.touched()).toBe(false));
    });
  });

  describe('validation', () => {
    it('should have no error when all valid', () => {
      const arr = createStringArray();

      expect(arr.error()).toBe('');
      expect(arr.ownError()).toBe('');
      expect(arr.valid()).toBe(true);
    });

    it('should aggregate child errors with index prefixes', () => {
      const arr = formArray(
        ['', 'valid', ''],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, {
            validator: () => (v) => (v ? '' : 'required'),
          }),
      );

      const error = arr.error();
      expect(error).toContain('0: required');
      expect(error).toContain('2: required');
      expect(error).not.toContain('1:');
    });

    it('ownError should reflect only the array-level validator', () => {
      const arr = formArray(
        ['a'],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, {
            validator: () => (v) => (v ? '' : 'required'),
          }),
        {
          validator: () => (v) => (v.length >= 2 ? '' : 'need at least 2'),
        },
      );

      expect(arr.ownError()).toBe('need at least 2');
      // ownError takes priority
      expect(arr.error()).toBe('need at least 2');
    });

    it('ownError should take priority over child errors', () => {
      const arr = formArray(
        [''],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, {
            validator: () => (v) => (v ? '' : 'required'),
          }),
        {
          validator: () => (v) => (v.length >= 2 ? '' : 'need at least 2'),
        },
      );

      expect(arr.error()).toBe('need at least 2');
    });

    it('should fall through to child errors when ownError is empty', () => {
      const arr = formArray(
        ['', 'valid'],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, {
            validator: () => (v) => (v ? '' : 'required'),
          }),
        {
          validator: () => (v) => (v.length >= 1 ? '' : 'need at least 1'),
        },
      );

      // ownError is empty (length >= 1)
      expect(arr.ownError()).toBe('');
      // child error shows
      expect(arr.error()).toContain('0: required');
    });

    it('should become valid when child errors are resolved', () => {
      const arr = formArray([''], (val: DerivedSignal<string[], string>) =>
        formControl(val, {
          validator: () => (v) => (v ? '' : 'required'),
        }),
      );

      expect(arr.valid()).toBe(false);

      arr.children()[0].value.set('fixed');
      expect(arr.valid()).toBe(true);
    });
  });

  describe('pending and valid', () => {
    it('should not be pending by default', () => {
      const arr = createStringArray();

      expect(arr.pending()).toBe(false);
    });

    it('should be pending when array-level pending is set', () => {
      const pending = signal(false);
      const arr = formArray(['a'], simpleFactory, {
        pending: () => pending(),
      });

      expect(arr.pending()).toBe(false);

      pending.set(true);
      expect(arr.pending()).toBe(true);
    });

    it('should be pending when any child is pending', () => {
      const childPending = signal(false);
      const arr = formArray(
        ['a', 'b'],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, { pending: () => childPending() }),
      );

      expect(arr.pending()).toBe(false);

      childPending.set(true);
      expect(arr.pending()).toBe(true);
    });

    it('should be invalid when pending', () => {
      const arr = formArray(['a'], simpleFactory, {
        pending: () => true,
      });

      expect(arr.valid()).toBe(false);
    });

    it('should be invalid when any child is invalid', () => {
      const arr = formArray([''], (val: DerivedSignal<string[], string>) =>
        formControl(val, {
          validator: () => (v) => (v ? '' : 'required'),
        }),
      );

      expect(arr.valid()).toBe(false);
    });
  });

  describe('min, max, canAdd, canRemove', () => {
    it('should default min to 0 and max to MAX_SAFE_INTEGER', () => {
      const arr = createStringArray();

      expect(arr.min()).toBe(0);
      expect(arr.max()).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should reflect custom min and max', () => {
      const min = signal(1);
      const max = signal(5);
      const arr = formArray(['a', 'b'], simpleFactory, {
        min: () => min(),
        max: () => max(),
      });

      expect(arr.min()).toBe(1);
      expect(arr.max()).toBe(5);

      min.set(2);
      max.set(3);
      expect(arr.min()).toBe(2);
      expect(arr.max()).toBe(3);
    });

    it('canAdd should be true when length < max', () => {
      const arr = formArray(['a'], simpleFactory, {
        max: () => 3,
      });

      expect(arr.canAdd()).toBe(true);

      arr.push('b');
      arr.push('c');
      expect(arr.canAdd()).toBe(false);
    });

    it('canRemove should be true when length > min', () => {
      const arr = formArray(['a', 'b', 'c'], simpleFactory, {
        min: () => 2,
      });

      expect(arr.canRemove()).toBe(true);

      arr.remove(0);
      expect(arr.canRemove()).toBe(false);
    });

    it('canAdd should be false when disabled', () => {
      const arr = formArray(['a'], simpleFactory, {
        max: () => 5,
        disable: () => true,
      });

      expect(arr.canAdd()).toBe(false);
    });

    it('canRemove should be false when disabled', () => {
      const arr = formArray(['a', 'b'], simpleFactory, {
        min: () => 0,
        disable: () => true,
      });

      expect(arr.canRemove()).toBe(false);
    });

    it('canAdd should be false when readonly', () => {
      const arr = formArray(['a'], simpleFactory, {
        max: () => 5,
        readonly: () => true,
      });

      expect(arr.canAdd()).toBe(false);
    });

    it('canRemove should be false when readonly', () => {
      const arr = formArray(['a', 'b'], simpleFactory, {
        min: () => 0,
        readonly: () => true,
      });

      expect(arr.canRemove()).toBe(false);
    });
  });

  describe('reconcile', () => {
    it('should update children and array value when not dirty', () => {
      const arr = createStringArray(['a', 'b']);

      arr.reconcile(['x', 'y']);

      expect(arr.children()[0].value()).toBe('x');
      expect(arr.children()[1].value()).toBe('y');
      expect(arr.dirty()).toBe(false);
    });

    it('should preserve dirty child values', () => {
      const arr = createStringArray(['a', 'b']);

      arr.children()[0].value.set('edited');

      arr.reconcile(['server-a', 'server-b']);

      // dirty child keeps its value
      expect(arr.children()[0].value()).toBe('edited');
      // pristine child gets updated
      expect(arr.children()[1].value()).toBe('server-b');
    });

    it('should handle reconcile with different length', () => {
      const arr = createStringArray(['a', 'b']);

      arr.reconcile(['x', 'y', 'z']);

      // Reconcile uses mergeArray which maps over new array length
      // Since array wasn't dirty, it should not update
      expect(arr.value().length).toBe(2);
    });
  });

  describe('forceReconcile', () => {
    it('should update all children even when dirty', () => {
      const arr = createStringArray(['a', 'b']);

      arr.children()[0].value.set('edited');
      arr.children()[1].value.set('edited2');

      arr.forceReconcile(['forced-a', 'forced-b']);

      expect(arr.children()[0].value()).toBe('forced-a');
      expect(arr.children()[1].value()).toBe('forced-b');
      expect(arr.dirty()).toBe(false);
    });

    it('should handle forceReconcile with different length', () => {
      const arr = createStringArray(['a', 'b', 'c']);

      arr.children()[0].value.set('dirty');

      arr.forceReconcile(['x']);

      expect(arr.value()).toEqual(['x']);
      expect(arr.children().length).toBe(1);
    });
  });

  describe('reset', () => {
    it('should reset all children and array to initial values', () => {
      const arr = createStringArray(['a', 'b']);

      arr.children()[0].value.set('changed');
      arr.push('c');

      arr.reset();

      expect(arr.value()).toEqual(['a', 'b']);
      expect(arr.children().length).toBe(2);
      expect(arr.dirty()).toBe(false);
    });

    it('should reset to reconciled initial value', () => {
      const arr = createStringArray(['a', 'b']);

      arr.reconcile(['x', 'y']);
      arr.children()[0].value.set('edited');

      arr.reset();

      expect(arr.children()[0].value()).toBe('x');
      expect(arr.children()[1].value()).toBe('y');
    });
  });

  describe('resetWithInitial', () => {
    it('should reset array with a new initial value', () => {
      const arr = createStringArray(['a', 'b']);

      arr.children()[0].value.set('changed');

      arr.resetWithInitial(['x', 'y', 'z']);

      expect(arr.value()).toEqual(['x', 'y', 'z']);
      expect(arr.children().length).toBe(3);
      expect(arr.dirty()).toBe(false);
    });

    it('should set new initial so future resets use it', () => {
      const arr = createStringArray(['a', 'b']);

      arr.resetWithInitial(['x', 'y']);
      arr.children()[0].value.set('changed');

      arr.reset();

      expect(arr.children()[0].value()).toBe('x');
      expect(arr.children()[1].value()).toBe('y');
    });
  });

  describe('partialValue', () => {
    it('should be undefined when not dirty', () => {
      const arr = createStringArray();

      expect(arr.partialValue()).toBeUndefined();
    });

    it('should return array of partial values when dirty', () => {
      const arr = createStringArray(['a', 'b', 'c']);

      arr.children()[1].value.set('changed');

      const pv = arr.partialValue();
      expect(pv).toBeDefined();
      expect(pv?.[1]).toBe('changed');
    });

    it('should return undefined for pristine children with controlType=control', () => {
      const arr = createStringArray(['a', 'b', 'c']);

      arr.children()[0].value.set('changed');

      const pv = arr.partialValue();
      expect(pv?.[0]).toBe('changed');
      expect(pv?.[1]).toBeUndefined();
      expect(pv?.[2]).toBeUndefined();
    });

    it('should return full value for non-control children that are not dirty', () => {
      type Item = { name: string; age: number };
      const items: Item[] = [
        { name: 'A', age: 1 },
        { name: 'B', age: 2 },
      ];

      const arr = formArray(items, (val: DerivedSignal<Item[], Item>) => {
        const src = val;
        return formGroup(src, {
          name: formControl(derived(src, 'name')),
          age: formControl(derived(src, 'age')),
        });
      });

      // Make only one child dirty
      arr.children()[0].children().name.value.set('Changed');

      const pv = arr.partialValue();
      expect(pv).toBeDefined();
      // dirty child should have partial value
      expect(pv?.[0].name).toBe('Changed');
      expect(pv?.[1]).toEqual({});
    });
  });

  describe('with complex children (formGroup items)', () => {
    type Item = { name: string; score: number };

    function createItemArray(initial: Item[] = [{ name: 'A', score: 10 }]) {
      return formArray(initial, (val: DerivedSignal<Item[], Item>) => {
        const src = val;
        return formGroup(src, {
          name: formControl(derived(src, 'name'), {
            validator: () => (v) => (v ? '' : 'required'),
            label: () => 'Name',
          }),
          score: formControl(derived(src, 'score'), {
            label: () => 'Score',
          }),
        });
      });
    }

    it('should create group children for each array element', () => {
      const arr = createItemArray([
        { name: 'A', score: 10 },
        { name: 'B', score: 20 },
      ]);

      expect(arr.children().length).toBe(2);
      expect(arr.children()[0].children().name.value()).toBe('A');
      expect(arr.children()[1].children().score.value()).toBe(20);
    });

    it('should propagate dirty from deeply nested children', () => {
      const arr = createItemArray();

      expect(arr.dirty()).toBe(false);

      arr.children()[0].children().name.value.set('Changed');
      expect(arr.children()[0].dirty()).toBe(true);
      expect(arr.dirty()).toBe(true);
    });

    it('should propagate touched via markAllAsTouched', () => {
      const arr = createItemArray([
        { name: 'A', score: 10 },
        { name: 'B', score: 20 },
      ]);

      arr.markAllAsTouched();

      expect(arr.touched()).toBe(true);
      expect(arr.children()[0].children().name.touched()).toBe(true);
      expect(arr.children()[1].children().score.touched()).toBe(true);
    });

    it('should propagate validation from group children', () => {
      const arr = createItemArray([{ name: '', score: 10 }]);

      expect(arr.valid()).toBe(false);
      expect(arr.error()).toContain('0:');
    });

    it('should push and create new group children', () => {
      const arr = createItemArray();

      arr.push({ name: 'B', score: 20 });

      expect(arr.children().length).toBe(2);
      expect(arr.children()[1].children().name.value()).toBe('B');
      expect(arr.children()[1].children().score.value()).toBe(20);
    });

    it('should reset nested group children', () => {
      const arr = createItemArray([{ name: 'A', score: 10 }]);

      arr.children()[0].children().name.value.set('Changed');
      arr.children()[0].children().score.value.set(99);

      arr.reset();

      expect(arr.children()[0].children().name.value()).toBe('A');
      expect(arr.children()[0].children().score.value()).toBe(10);
    });
  });

  describe('two-way binding with DerivedSignal', () => {
    it('should write child changes back to source', () => {
      const parent = signal({ items: ['x', 'y'] });
      const itemsDerived = derived(parent, 'items');
      const arr = formArray(itemsDerived, simpleFactory);

      arr.children()[0].value.set('changed');

      expect(parent().items[0]).toBe('changed');
    });

    it('should reflect source changes in children', () => {
      const parent = signal({ items: ['x', 'y'] });
      const itemsDerived = derived(parent, 'items');
      const arr = formArray(itemsDerived, simpleFactory);

      parent.set({ items: ['a', 'b'] });

      expect(arr.children()[0].value()).toBe('a');
      expect(arr.children()[1].value()).toBe('b');
    });
  });

  describe('combined lifecycle', () => {
    it('full lifecycle: create, push, edit, validate, reconcile, reset', () => {
      const arr = formArray(
        ['hello'],
        (val: DerivedSignal<string[], string>) =>
          formControl(val, {
            validator: () => (v) => (v.length > 0 ? '' : 'required'),
          }),
        {
          min: () => 1,
          max: () => 3,
        },
      );

      // initial state
      expect(arr.dirty()).toBe(false);
      expect(arr.touched()).toBe(false);
      expect(arr.valid()).toBe(true);
      expect(arr.partialValue()).toBeUndefined();
      expect(arr.canAdd()).toBe(true);
      expect(arr.canRemove()).toBe(false); // length 1, min 1

      // push
      arr.push('world');
      expect(arr.dirty()).toBe(true);
      expect(arr.canRemove()).toBe(true);
      expect(arr.children().length).toBe(2);

      // touch all
      arr.markAllAsTouched();
      expect(arr.touched()).toBe(true);
      arr.children().forEach((c) => expect(c.touched()).toBe(true));

      // edit to create validation error
      arr.children()[0].value.set('');
      expect(arr.valid()).toBe(false);

      // fix
      arr.children()[0].value.set('fixed');
      expect(arr.valid()).toBe(true);

      // reconcile (preserves dirty children)
      arr.reconcile(['server-a', 'server-b']);
      expect(arr.children()[0].value()).toBe('fixed');

      // force reconcile
      arr.forceReconcile(['fa', 'fb']);
      expect(arr.children()[0].value()).toBe('fa');
      expect(arr.children()[1].value()).toBe('fb');

      // edit and reset
      arr.children()[0].value.set('edited');
      arr.reset();
      expect(arr.children()[0].value()).toBe('fa');
      expect(arr.dirty()).toBe(false);

      // resetWithInitial
      arr.resetWithInitial(['new-a']);
      expect(arr.value()).toEqual(['new-a']);
      expect(arr.children().length).toBe(1);
      expect(arr.dirty()).toBe(false);

      // now at max should be checked
      arr.push('new-b');
      arr.push('new-c');
      expect(arr.canAdd()).toBe(false);
    });
  });
});
