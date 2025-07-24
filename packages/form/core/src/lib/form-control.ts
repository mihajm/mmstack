import {
  computed,
  isSignal,
  signal,
  untracked,
  type CreateSignalOptions,
  type Signal,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';
import { type DerivedSignal } from '@mmstack/primitives';
import { generateID } from './util';

/**
 * Represents the type of a form control.
 * - `control`: A single form control (e.g., an input field).
 * - `array`: An array of form controls (like Angular's `FormArray`).
 * - `group`: A group of form controls (like Angular's `FormGroup`).
 */
export type ControlType = 'control' | 'array' | 'group';

/**
 * Represents a reactive form control.  It holds the value, validation status, and other
 * metadata for a form field.  This is the core building block for creating reactive forms
 * with signals.
 *
 * @typeParam T - The type of the form control's value.
 * @typeParam TParent - The type of the parent form control's value (if this control is part of a group or array). Defaults to `undefined`.
 * @typeParam TControlType - The type of the control ('control', 'array', or 'group'). Defaults to 'control'.
 * @typeParam TPartialValue -  The type of the partial value, used for patching.
 */
export type FormControlSignal<
  T,
  TParent = undefined,
  TControlType extends ControlType = 'control',
  TPartialValue = T | undefined,
> = {
  /** A unique identifier for the control. Used for tracking in `@for` loops. */
  id: string;
  /** The main value signal for the control. */
  value: WritableSignal<T>;
  /** A signal indicating whether the control's value has been changed. */
  dirty: Signal<boolean>;
  /** A signal indicating whether the control has been interacted with (e.g., blurred). */
  touched: Signal<boolean>;
  /** A signal containing the current validation error message (empty string if valid). */
  error: Signal<string>;
  /** A signal indicating whether the control is pending */
  pending: Signal<boolean>;
  /** A signal indicating whether the control is disabled. */
  /** A signal indicating whether the control is in a valid state (without errors & not pending) */
  valid: Signal<boolean>;
  disabled: Signal<boolean>;
  /** A signal indicating whether the control is read-only. */
  readonly: Signal<boolean>;
  /** A signal indicating whether the control is required. */
  required: Signal<boolean>;
  /** A signal containing the label for the control. */
  label: Signal<string>;
  /** A signal containing the hint text for the control. */
  hint: Signal<string>;
  /** Marks the control as touched. */
  markAsTouched: () => void;
  /** Marks the control and all its child controls (if any) as touched. */
  markAllAsTouched: () => void;
  /** Marks the control as pristine (not touched). */
  markAsPristine: () => void;
  /** Marks the control and all its child controls (if any) as pristine. */
  markAllAsPristine: () => void;
  /**
   * Resets the control to a new value and sets a new initial value. This is intended for
   * scenarios where the underlying data is updated externally (e.g., data coming from
   * the server).  If the control is not dirty, the value is updated. If the control *is*
   * dirty, the value is *not* updated (preserving user changes).
   */
  reconcile: (newValue: T) => void;
  /**
   * Similar to `reconcile`, but forces the update even if the control is dirty.
   */
  forceReconcile: (newValue: T) => void;
  /** Resets the control's value to its initial value. */
  reset: () => void;
  /** Resets the control's value and initial value. */
  resetWithInitial: (initial: T) => void;
  /**
   * The derivation function used to create this control if it's part of a `formGroup` or `formArray`.
   * @internal
   */
  from?: DerivedSignal<TParent, T>['from'];
  /** The equality function used to compare values. Defaults to `Object.is`. */
  equal: (a: T, b: T) => boolean;
  /** The type of the control ('control', 'array', or 'group'). */
  controlType: TControlType;
  /**
   * A signal representing the partial value of the control, suitable for patching data on a server.
   * It contains the changed value if `dirty` is `true`.
   */
  partialValue: Signal<TPartialValue>;
};

export type CreateFormControlOptions<
  T,
  TControlType extends ControlType = ControlType,
> = CreateSignalOptions<T> & {
  validator?: () => (value: T) => string;
  onTouched?: () => void;
  disable?: () => boolean;
  readonly?: () => boolean;
  required?: () => boolean;
  label?: () => string;
  id?: () => string;
  hint?: () => string;
  dirtyEquality?: ValueEqualityFn<T>;
  onReset?: () => void;
  controlType?: TControlType;
  overrideValidation?: () => string;
  pending?: () => boolean;
};

/**
 * Creates a `FormControlSignal`, a reactive form control that holds a value and tracks its
 * validity, dirty state, touched state, and other metadata.
 *
 * @typeParam T - The type of the form control's value.
 * @typeParam TParent - The type of the parent form control's value (if this control is part of a group or array).
 * @typeParam TControlType - The type of the control. Defaults to `'control'`.
 * @typeParam TPartialValue - The type of value when patching
 * @param initial - The initial value of the control, or a `DerivedSignal` if this control is part of a `formGroup` or `formArray`.
 * @param options - Optional configuration options for the control.
 * @returns A `FormControlSignal` instance.
 *
 * @example
 * // Create a simple form control:
 * const name = formControl('Initial Name');
 *
 * // Create a form control with validation:
 * const age = formControl(0, {
 *   validator: () => (value) => value >= 18 ? '' : 'Must be at least 18',
 * });
 *
 * // Create a derived form control (equivalent to the above, but more explicit):
 *  const user = signal({ name: 'John Doe', age: 30 });
 *  const name = formControl(derived(user, {
 *    from: (u) => u.name,
 *    onChange: (newName) => user.update(u => ({...u, name: newName}))
 *  }));
 *
 * // Create a form group with nested controls:
 * const user = signal({ name: 'John Doe', age: 30 });
 * const form = formGroup(user, {
 *  name: formControl(derived(user, 'name')),
 *  age: formControl(derived(user, 'age')),
 * })
 */
export function formControl<
  T,
  TParent = undefined,
  TControlType extends ControlType = 'control',
  TPartialValue = T | undefined,
>(
  initial: DerivedSignal<TParent, T> | T,
  opt?: CreateFormControlOptions<T, TControlType>,
): FormControlSignal<T, TParent, TControlType, TPartialValue> {
  const value = isSignal(initial) ? initial : signal(initial, opt);
  const initialValue = signal(untracked(value));
  const eq = opt?.equal ?? Object.is;

  const dirtyEq = opt?.dirtyEquality ?? eq;

  const disabled = computed(() => opt?.disable?.() ?? false);
  const readonly = computed(() => opt?.readonly?.() ?? false);

  const dirty = computed(() => !dirtyEq(value(), initialValue()));

  const touched = signal(false);

  const validator = computed(() => opt?.validator?.() ?? (() => ''));

  const error = computed(() => {
    if (opt?.overrideValidation) return opt.overrideValidation();
    if (disabled() || readonly()) return '';
    return validator()(value());
  });

  const markAsTouched = () => {
    touched.set(true);
    opt?.onTouched?.();
  };
  const markAllAsTouched = markAsTouched;

  const markAsPristine = () => touched.set(false);
  const markAllAsPristine = markAsPristine;

  const label = computed(() => opt?.label?.() ?? '');

  const partialValue = computed(() => (dirty() ? value() : undefined));

  const internalReconcile = (newValue: T, force = false) => {
    const isDirty = untracked(dirty);

    if (!isDirty || force) {
      // very dangerous use of untracked here, don't do this everywhere :)
      // thanks to  u/synalx for the idea to use untracked here

      untracked(() => {
        initialValue.set(newValue);
        value.set(newValue);
      });
    }
  };

  const pending = computed(() => opt?.pending?.() ?? false);

  return {
    id: opt?.id?.() ?? generateID(),
    value,
    dirty,
    touched,
    error,
    label,
    required: computed(() => opt?.required?.() ?? false),
    disabled,
    readonly,
    pending,
    valid: computed(() => !pending() && !error()),
    hint: computed(() => opt?.hint?.() ?? ''),
    markAsTouched,
    markAllAsTouched,
    markAsPristine,
    markAllAsPristine,
    from: (isSignal(initial) ? initial.from : undefined) as FormControlSignal<
      T,
      TParent,
      TControlType
    >['from'],
    reconcile: (newValue: T) => internalReconcile(newValue),
    forceReconcile: (newValue: T) => internalReconcile(newValue, true),
    reset: () => {
      opt?.onReset?.();
      value.set(untracked(initialValue));
    },
    resetWithInitial: (initial: T) => {
      opt?.onReset?.();
      initialValue.set(initial);
      value.set(initial);
    },
    equal: eq,
    controlType: (opt?.controlType ?? 'control') as TControlType,
    partialValue: partialValue as Signal<TPartialValue>,
  };
}
