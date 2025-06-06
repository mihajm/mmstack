import { computed, Signal, signal, WritableSignal } from '@angular/core';
import { type ArrayValidatorOptions } from '@mmstack/form-validation';
import { type DerivedSignal } from '@mmstack/primitives';
import {
  createMultiSelectState,
  injectCreateMultiSelectState,
  MultiSelectState,
  MultiSelectStateOptions,
} from './multi-select';
import { type SelectState } from './select';

/**
 * Represents the reactive state for a autocompletable chips form control
 *
 * Adapts `MultiSelectState` to manage an array of strings as its value. Key differences include:
 * * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see SelectState (for single selection)
 * @see FormControlSignal
 */
export type ChipsState<TParent = undefined> = Omit<
  MultiSelectState<string[], TParent>,
  'type'
> & {
  /** Type discriminator for chip controls. */
  type: 'chips';
  query: WritableSignal<string>;
  separatorCodes: Signal<number[]>;
  labeledValue: Signal<
    {
      value: string;
      label: string;
    }[]
  >;
};

/**
 * Configuration options required by the `createChipsState` function.
 *
 * Adapts `SelectStateOptions` for multi-select controls. Key functions like `options`,
 * `identify`, `display`, and `disableOption` are redefined here to operate on the
 * **individual element type** (`T[number]`) rather than the array type `T`.
 *
 * @see MultiSelectStateOptions
 * @see createChipsState
 */
export type ChipsStateOptions = Omit<
  MultiSelectStateOptions<string[]>,
  'identify' | 'options'
> & {
  options?: MultiSelectStateOptions<string[]>['options'];
  separatorCodes?: () => number[];
};

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateChipsState`.
 *
 * Extends `ChipsStateOptions` but omits base properties handled internally
 * (`validator`, `required`). Requires validation rules *for the selected array itself*
 * via the `validation` property using `ArrayValidatorOptions`.
 *
 * @see injectCreateChipsState
 * @see ChipsStateOptions
 * @see ArrayValidatorOptions
 */
export type InjectedChipsStateOptions = Omit<
  ChipsStateOptions,
  'required' | 'validator' // Properties handled internally
> & {
  /**
   * Optional function returning an `ArrayValidatorOptions` object defining validation rules
   * for the *array* of selected values (e.g., minimum/maximum number of selections).
   * The factory uses this with the injected `validators.array.all()` method.
   * @example validation: () => ({ minLength: 1 }) // Must select at least one item
   * @example validation: () => ({ maxLength: 3 }) // Cannot select more than 3 items
   */
  validation?: () => ArrayValidatorOptions;
};

/**
 * Creates the reactive state object (`ChipsState`) for a autocompletable chips form control
 * without relying on Angular's dependency injection for validation.
 *
 * Handles the logic for managing an array of selected strings, deriving the list of
 * available individual options, identifying/displaying elements, and generating
 * a combined display label for the current selection.
 *
 * Prefer `injectCreateChipsState` for easier integration of array validation rules
 * (like min/max selections) within Angular applications.
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @param value The initial selected array, or a `DerivedSignal` linking it to a parent state.
 * @param opt Configuration options (`ChipsStateOptions`). **Note:** This parameter (and specifically `opt.options`) is required.
 * @returns A `ChipsState` instance managing the control's reactive state.
 * @see injectCreateChipsState
 * @see ChipsStateOptions
 */
export function createChipsState<TParent = undefined>(
  value: string[] | DerivedSignal<TParent, string[]>,
  opt?: ChipsStateOptions,
): ChipsState<TParent> {
  const state = createMultiSelectState(value, {
    ...opt,
    options: opt?.options ?? (() => []),
  });

  const query = signal('');

  const options = computed(() =>
    state
      .options()
      .filter((opt) => opt.value.toLowerCase().includes(query().toLowerCase())),
  );

  const displayFn = computed(
    () => opt?.display?.() ?? ((value: string) => value),
  );

  const labeledValue = computed(() => {
    const labelFn = displayFn();
    return state.value().map((value) => ({
      value,
      label: labelFn(value),
    }));
  });

  return {
    ...state,
    query,
    options,
    labeledValue,
    type: 'chips',
    separatorCodes: computed(() => opt?.separatorCodes?.() ?? [13, 188]), // Default to enter and comma
  };
}

/**
 * Creates and returns a factory function for generating `ChipsState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`) to simplify
 * the application of validation rules *on the array* of selected values (e.g., minimum/maximum
 * number of selections) using `ArrayValidatorOptions` via the `validation` option. It also handles
 * enhanced error display for these array-level validations.
 *
 * Other configuration (`options`, `identify`, `display`, etc.) is passed through to the
 * underlying `createChipsState`.
 *
 * This is the **recommended** way to create `ChipsState` within an Angular application.
 *
 * @returns A factory function: `(value: string[] | DerivedSignal<TParent, string[]>, opt: InjectedChipsStateOptions) => ChipsState<TParent>`.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 */
export function injectCreateChipsState() {
  const factory = injectCreateMultiSelectState();

  /**
   * Factory function (returned by `injectCreateChipsState`) that creates `ChipsState`.
   * Integrates with `@mmstack/form-validation` via DI for array validation (e.g., min/max items selected).
   *
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial selected array, or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedChipsStateOptions`), including the required `options` function
   * and the `validation` property (accepting `ArrayValidatorOptions`). **Note:** `opt` is required.
   * @returns A `ChipsState` instance managing the control's reactive state.
   */
  return <TParent = undefined>(
    value: string[] | DerivedSignal<TParent, string[]>,
    opt?: InjectedChipsStateOptions,
  ): ChipsState<TParent> => {
    const state = factory(value, {
      ...opt,
      options: opt?.options ?? (() => []),
    });

    const query = signal('');

    const options = computed(() =>
      state
        .options()
        .filter((opt) =>
          opt.value.toLowerCase().includes(query().toLowerCase()),
        ),
    );

    const displayFn = computed(
      () => opt?.display?.() ?? ((value: string) => value),
    );

    const labeledValue = computed(() => {
      const labelFn = displayFn();
      const value = state.value();

      return value.map((value) => ({
        value,
        label: labelFn(value),
      }));
    });

    return {
      ...state,
      query,
      options,
      labeledValue,
      separatorCodes: computed(() => opt?.separatorCodes?.() ?? [13, 188]), // Default to enter and comma
      type: 'chips',
    };
  };
}
