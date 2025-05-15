import {
  computed,
  isSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { entries, mergeIfObject, values } from '@mmstack/object';
import {
  isDerivation,
  toFakeSignalDerivation,
  type DerivedSignal,
} from '@mmstack/primitives';
import {
  formControl,
  type CreateFormControlOptions,
  type FormControlSignal,
} from './form-control';
import { type SignalValue } from './signal-value.type';

/**
 * Extracts the partial value types from a record of `FormControlSignal` instances.
 * This is used to construct the `partialValue` type for `FormGroupSignal`.
 * @internal
 */
type DerivationPartialValues<
  TDerivations extends Record<string, FormControlSignal<any, any, any, any>>,
> = {
  [K in keyof TDerivations]: Exclude<
    SignalValue<TDerivations[K]['partialValue']>,
    undefined
  >;
};

/**
 * Represents a group of form controls, similar to Angular's `FormGroup`.  It aggregates
 * the values and states of its child controls into a single object.
 *
 * @typeParam T - The type of the form group's value (an object).
 * @typeParam TDerivations - A record where keys are the names of the child controls and values are the `FormControlSignal` instances.
 * @typeParam TParent - The type of the parent form control's value (if this group is nested).
 */
export type FormGroupSignal<
  T,
  TDerivations extends Record<string, FormControlSignal<any, T, any, any>>,
  TParent = undefined,
> = FormControlSignal<
  T,
  TParent,
  'group',
  Partial<DerivationPartialValues<TDerivations>>
> & {
  /**
   * A signal that holds a record of the child form controls.  The keys are the names
   * of the controls, and the values are the `FormControlSignal` instances.
   */
  children: Signal<TDerivations>;
  /**
   * A signal that holds the validation error message of the group itself (excluding child errors).
   */
  ownError: Signal<string>;
};

/**
 * Options for creating a `FormGroupSignal`.  Extends `CreateFormControlOptions`.
 */
export type CreateFormGroupOptions<
  T,
  TDerivations extends Record<string, FormControlSignal<any, T, any, any>>,
> = CreateFormControlOptions<T, 'group'> & {
  /**
   * An optional function to create a base object for the `partialValue` signal.
   * This can be used to pre-populate the partial value with default values or
   * to perform custom logic before merging in the partial values from child controls.
   */
  createBasePartialValue?: (
    value: T,
  ) => Partial<DerivationPartialValues<TDerivations>>;
};

/**
 * Creates a `FormGroupSignal`, which aggregates a set of child form controls into a single object.
 *
 * @typeParam T - The type of the form group's value (an object).
 * @typeParam TDerivations -  A record where keys are the names of the child controls and values are the `FormControlSignal` instances.
 * @typeParam TParent - The type of the parent form control's value (if this group is nested within another group or array).
 * @param initial - The initial value of the form group (or a `WritableSignal` or `DerivedSignal` if the group is nested).
 * @param providedChildren - An object containing the child `FormControlSignal` instances, or a function that returns such an object.
 *                        Using a function allows for dynamic creation of child controls (e.g., in response to changes in other signals).
 * @param options - Optional configuration options for the form group.
 * @returns A `FormGroupSignal` instance.
 *
 * @example
 * // Create a simple form group:
 *  const user = signal({ name: 'John Doe', age: 30 });
 *  const form = formGroup(user, {
 *  name: formControl(derived(user, 'name')),
 *  age: formControl(derived(user, 'age')),
 *  })
 *
 * // Create a nested form group:
 *  const user = signal({ name: 'John', age: 30, address: {street: "Some street"} });
 *
 * const address = derived(user, 'address');
 * const userForm = formGroup(user, {
 *   name: formControl(derived(user, 'name')),
 *   age: formControl(derived(user, 'age')),
 *   address: formGroup(address, {
 *       street: formControl(derived(address, (address) => address.street), {
 *           validator: () => (value) => value ? "" : "required!"
 *       }) // you can create deeply nested structures.
 *   })
 * });
 *
 * // Create a form group with dynamically created children replaced rare FormRecord requirements.
 * const showAddress = signal(false);
 * type Characteristic = {
 *  valueType: 'string';
 *  value: string;
 * } | {
 *  valueType: 'number';
 *  value: number;
 * }
 * const char = signal<Characteristic>({ valueType: 'string', value: '' });
 * const charForm = formGroup(char, () => {
 *  if (char().valueType === 'string) return createStringControl(char);
 *  return createNumberControl(char);
 * });
 *
 */
export function formGroup<
  T,
  TDerivations extends Record<string, FormControlSignal<any, T, any, any>>,
  TParent = undefined,
>(
  initial: DerivedSignal<TParent, T> | T | WritableSignal<T>,
  providedChildren: (() => TDerivations) | TDerivations,
  opt?: CreateFormGroupOptions<T, TDerivations>,
): FormGroupSignal<T, TDerivations, TParent> {
  const valueSignal = isSignal(initial) ? initial : signal(initial);
  // we fake a derivation if not present, so that .from is present on the signal
  const value = isDerivation<TParent, T>(valueSignal)
    ? valueSignal
    : toFakeSignalDerivation<TParent, T>(valueSignal);

  // we allow for a function/signal to be passed, this case should only be used if the child controls change dependent upon something, say if a formControl is flipped into a formGroup.
  const children =
    typeof providedChildren === 'function'
      ? computed(() => providedChildren())
      : computed(() => providedChildren);

  // array allows for easier handling
  const derivationsArray = computed(() => values(children()));

  const childrenDirty = computed(
    () =>
      !!derivationsArray().length && derivationsArray().some((d) => d.dirty()),
  );

  // by default dont compare object references, just use childrenDirtySignal
  const baseDirtyEq = opt?.dirtyEquality ?? opt?.equal ?? (() => true);

  // function which calls a signal becomes a signal
  const dirtyEquality = (a: T, b: T) => {
    return baseDirtyEq(a, b) && !childrenDirty();
  };

  // group control
  const ctrl = formControl<T, TParent, 'group'>(value, {
    ...opt,
    dirtyEquality,
    controlType: 'group',
    readonly: () => {
      // readonly if is readonly or all children are readonly
      if (opt?.readonly?.()) return true;
      return (
        !!derivationsArray().length &&
        derivationsArray().every((d) => d.readonly())
      );
    },
    disable: () => {
      if (opt?.disable?.()) return true;
      return (
        !!derivationsArray().length &&
        derivationsArray().every((d) => d.disabled())
      );
    },
  }) satisfies FormControlSignal<T, TParent, 'group'>;

  const childrenTouched = computed(
    () =>
      !!derivationsArray().length &&
      derivationsArray().some((d) => d.touched()),
  );

  const touched = computed(() => ctrl.touched() || childrenTouched());

  const childError = computed(() => {
    if (!derivationsArray().length) return '';
    return derivationsArray()
      .map((d) => (d.error() ? `${d.label()}: ${d.error()}` : ''))
      .filter(Boolean)
      .join('\n');
  });

  const error = computed(() => {
    const ownError = ctrl.error();
    if (ownError) return ownError;
    return childError() ? 'INVALID' : '';
  });

  const markAllAsTouched = () => {
    ctrl.markAllAsTouched();
    for (const ctrl of untracked(derivationsArray)) {
      ctrl.markAllAsTouched();
    }
  };

  const markAllAsPristine = () => {
    ctrl.markAllAsPristine();
    for (const ctrl of untracked(derivationsArray)) {
      ctrl.markAllAsPristine();
    }
  };

  const reconcile = (newValue: T) => {
    // set the children values based on the derivation of the new value
    for (const ctrl of untracked(derivationsArray)) {
      const from = ctrl.from;
      if (!from) continue;
      ctrl.reconcile(from(newValue));
    }
    ctrl.reconcile(mergeIfObject(newValue, untracked(value)));
  };

  const forceReconcile = (newValue: T) => {
    for (const ctrl of untracked(derivationsArray)) {
      const from = ctrl.from;
      if (!from) continue;
      ctrl.forceReconcile(from(newValue));
    }
    ctrl.forceReconcile(newValue);
  };

  const createBaseValueFn = opt?.createBasePartialValue;

  const basePartialValue: Signal<
    Partial<DerivationPartialValues<TDerivations>>
  > = createBaseValueFn
    ? computed(() => createBaseValueFn(ctrl.value()))
    : computed(() => ({}));

  const partialValue = computed(() => {
    const obj: Partial<DerivationPartialValues<TDerivations>> = {
      ...basePartialValue(),
    };

    if (!ctrl.dirty()) return obj;

    for (const [key, ctrl] of entries(children())) {
      const pv = ctrl.partialValue();

      if (pv === undefined) continue;
      obj[key] = pv;
    }

    return obj;
  });

  const childrenValid = computed(() => {
    if (!derivationsArray().length) return true;
    return derivationsArray().every((d) => d.valid());
  });

  const childrenPending = computed(
    () =>
      !!derivationsArray().length &&
      derivationsArray().some((d) => d.pending()),
  );

  return {
    ...ctrl,
    children,
    partialValue,
    reconcile,
    forceReconcile,
    ownError: ctrl.error,
    touched,
    error,
    valid: computed(() => ctrl.valid() && childrenValid()),
    pending: computed(() => ctrl.pending() || childrenPending()),
    markAllAsPristine,
    markAllAsTouched,
    reset: () => {
      for (const ctrl of untracked(derivationsArray)) {
        ctrl.reset();
      }
      ctrl.reset();
    },
    resetWithInitial: (initial: T) => {
      for (const ctrl of untracked(derivationsArray)) {
        const from = ctrl.from;
        if (from) ctrl.resetWithInitial(from(initial));
        else ctrl.reset();
      }
      ctrl.resetWithInitial(initial);
    },
  };
}
