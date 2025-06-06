import { computed } from '@angular/core';
import { formControl } from '@mmstack/form-core';
import {
  type ArrayValidatorOptions,
  injectValidators,
} from '@mmstack/form-validation';
import { type DerivedSignal } from '@mmstack/primitives';
import { tooltip } from '../util';
import { type SelectState, type SelectStateOptions } from './select';

export function defaultJoinLabel(labels: string[]) {
  const first = labels.at(0);
  if (!first) return '';
  if (labels.length === 1) return first;
  return `${first}, +${labels.length - 1}`;
}

/**
 * Represents the reactive state for a multi-selection form control
 * (e.g., `<mat-select multiple>`, multi-select checkboxes).
 *
 * Adapts `SelectState` to manage an array (`T`) as its value. Key differences include:
 * - `FormControlSignal<T>` where `T` is the **array type** (e.g., `string[]`, `MyType[]`).
 * - `options` signal contains the available **individual choices** (type `T[number]`).
 * - `equal` function compares **individual choices** (type `T[number]`).
 * - `valueLabel` provides a summarized string representation of the selected array.
 *
 * @template T The **array type** holding the selected values (e.g., `string[]`, `number[]`, `MyObject[]`).
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see SelectState (for single selection)
 * @see FormControlSignal
 */
export type MultiSelectState<T extends any[], TParent = undefined> = Omit<
  SelectState<T, TParent>,
  'type' | 'equal' | 'options'
> & {
  /**
   * The equality function used internally to compare **individual elements** (`T[number]`)
   * when determining selection state or changes within the options.
   * Derived from the `identify` function provided in the options by default.
   */
  equal: SelectState<T[number], TParent>['equal']; // Compares elements T[number]
  /**
   * Signal holding the array of available **individual selectable options** (type `T[number]`).
   * Each object includes `id`, `value`, computed `label`, and computed `disabled` properties
   * for the individual choice, suitable for rendering checkbox lists or multi-select dropdowns.
   */
  options: SelectState<T[number], TParent>['options']; // Options represent T[number]
  /** Type discriminator for multi-select controls. */
  type: 'multi-select';
};

/**
 * Configuration options required by the `createMultiSelectState` function.
 *
 * Adapts `SelectStateOptions` for multi-select controls. Key functions like `options`,
 * `identify`, `display`, and `disableOption` are redefined here to operate on the
 * **individual element type** (`T[number]`) rather than the array type `T`.
 *
 * @template T The **array type** holding the selected values (e.g., `string[]`).
 * @see SelectStateOptions
 * @see createMultiSelectState
 */
export type MultiSelectStateOptions<T extends any[]> = Omit<
  SelectStateOptions<T>, // Base options apply to the array T (e.g., label, hint)
  'options' | 'identify' | 'display' | 'disableOption' // Omit these as they need to work on T[number]
> & {
  /**
   * **Required**. Function returning the array of **all available individual choices**
   * (type `T[number][]`) that the user can select from.
   */
  options: SelectStateOptions<T[number]>['options'];
  /**
   * Optional function to generate a unique string identifier for an **individual choice** (`T[number]`).
   * Crucial for object values to ensure correct comparisons and selection state.
   * Defaults to string coercion (`${value}`).
   * @param value An individual option value of type `T[number]`.
   * @returns A unique string ID.
   */
  identify?: SelectStateOptions<T[number]>['identify'];
  /**
   * Optional function to generate the display label for an **individual choice** (`T[number]`).
   * Used within the `options` signal and potentially by `joinLabel`.
   * Defaults to string coercion (`${value}`).
   * @param value An individual option value of type `T[number]`.
   * @returns The string label to display.
   */
  display?: SelectStateOptions<T[number]>['display'];
  /**
   * Optional function to determine if an **individual choice** (`T[number]`) should be disabled
   * in the UI list. Defaults to `() => false`.
   * @param value An individual option value of type `T[number]`.
   * @returns `true` if the option should be disabled.
   */
  disableOption?: SelectStateOptions<T[number]>['disableOption'];
  /**
   * Optional function to format the array of display labels corresponding to the currently
   * selected items into a single summary string for the `valueLabel` signal.
   * Defaults to showing the first selected label and "+X more" if multiple are selected.
   * @param labels Array of display labels (`string[]`) for the currently selected items.
   * @returns A single string representation (e.g., "Apples, +2 more").
   */
  joinLabel?: () => (labels: string[]) => string;
};

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateMultiSelectState`.
 *
 * Extends `MultiSelectStateOptions` but omits base properties handled internally
 * (`validator`, `required`). Requires validation rules *for the selected array itself*
 * via the `validation` property using `ArrayValidatorOptions`.
 *
 * @template T The **array type** holding the selected values (e.g., `string[]`).
 * @see injectCreateMultiSelectState
 * @see MultiSelectStateOptions
 * @see ArrayValidatorOptions
 */
export type InjectedMultiSelectStateOptions<T extends any[]> = Omit<
  MultiSelectStateOptions<T>,
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
 * Creates the reactive state object (`MultiSelectState`) for a multi-select form control
 * without relying on Angular's dependency injection for validation.
 *
 * Handles the logic for managing an array of selected values (`T`), deriving the list of
 * available individual options (`T[number]`), identifying/displaying elements, and generating
 * a combined display label for the current selection.
 *
 * Prefer `injectCreateMultiSelectState` for easier integration of array validation rules
 * (like min/max selections) within Angular applications.
 *
 * @template T The **array type** holding the selected values (e.g., `string[]`).
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @param value The initial selected array (`T`), or a `DerivedSignal` linking it to a parent state.
 * @param opt Configuration options (`MultiSelectStateOptions`). **Note:** This parameter (and specifically `opt.options`) is required.
 * @returns A `MultiSelectState` instance managing the control's reactive state.
 * @see injectCreateMultiSelectState
 * @see MultiSelectStateOptions
 */
export function createMultiSelectState<T extends any[], TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: MultiSelectStateOptions<T>,
): MultiSelectState<T, TParent> {
  const identify = computed(() => opt.identify?.() ?? ((v: T) => `${v}`));

  const equal = (a: T[number], b: T[number]) => {
    return identify()(a) === identify()(b);
  };

  const state = formControl<T, TParent>(value, {
    ...opt,
    equal:
      opt.equal ??
      ((a: T, b: T) => {
        return a.length === b.length && a.every((v, i) => equal(v, b[i]));
      }),
  });

  const display = computed(() => opt.display?.() ?? ((v: T[number]) => `${v}`));

  const disableOption = computed(() => opt.disableOption?.() ?? (() => false));

  const valueIds = computed(() => new Set(state.value().map(identify())));
  const joinLabel = computed(() => opt.joinLabel?.() ?? defaultJoinLabel);
  const valueLabel = computed(() => joinLabel()(state.value().map(display())));

  const identifiedOptions = computed(() => {
    const identityFn = identify();

    return opt.options().map((value) => ({
      value,
      id: identityFn(value),
    }));
  });

  const options = computed(() => {
    return identifiedOptions().map((o) => ({
      ...o,
      label: computed(() => display()(o.value)),
      disabled: computed(() => {
        if (valueIds().has(o.id)) return false;
        return state.disabled() || state.readonly() || disableOption()(o.value);
      }),
    }));
  });

  const { shortened: error, tooltip: errorTooltip } = tooltip(
    state.error,
    opt.maxErrorHintLength,
  );
  const { shortened: hint, tooltip: hintTooltip } = tooltip(
    state.hint,
    opt.maxErrorHintLength,
  );

  return {
    ...state,
    valueLabel,
    options,
    equal,
    placeholder: computed(() => opt.placeholder?.() ?? ''),
    error,
    errorTooltip,
    hint,
    hintTooltip,
    type: 'multi-select',
  };
}

/**
 * Creates and returns a factory function for generating `MultiSelectState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`) to simplify
 * the application of validation rules *on the array* of selected values (e.g., minimum/maximum
 * number of selections) using `ArrayValidatorOptions` via the `validation` option. It also handles
 * enhanced error display for these array-level validations.
 *
 * Other configuration (`options`, `identify`, `display`, etc.) is passed through to the
 * underlying `createMultiSelectState`.
 *
 * This is the **recommended** way to create `MultiSelectState` within an Angular application.
 *
 * @returns A factory function: `(value: T | DerivedSignal<TParent, T>, opt: InjectedMultiSelectStateOptions<T>) => MultiSelectState<T, TParent>`.
 * @template T The **array type** holding the selected values (e.g., `string[]`).
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 *
 * @example
 * // Within an injection context:
 * const createMultiSelect = injectCreateMultiSelectState();
 *
 * type Category = { id: number; name: string };
 * const allCategories: Category[] = [ {id: 1, name: 'UI'}, {id: 2, name: 'API'}, {id: 3, name: 'Docs'} ];
 *
 * const categoryState = createMultiSelect<Category[]>([], { // Explicit T = Category[]
 * label: () => 'Categories',
 * options: () => allCategories, // All available choices
 * identify: () => cat => cat.id.toString(), // Use ID for comparison
 * display: () => cat => cat.name,          // Use name for display
 * validation: () => ({ minLength: 1, maxLength: 2 }) // Require 1 or 2 categories
 * });
 *
 * // Template usage (conceptual):
 * // <mat-select multiple [(ngModel)]="categoryState.value">
 * //   @for (option of categoryState.options(); track option.id) {
 * //     <mat-option [value]="option.value" [disabled]="option.disabled()">
 * //       {{ option.label() }}
 * //     </mat-option>
 * //   }
 * // </mat-select>
 */
export function injectCreateMultiSelectState() {
  const validators = injectValidators();

  /**
   * Factory function (returned by `injectCreateMultiSelectState`) that creates `MultiSelectState`.
   * Integrates with `@mmstack/form-validation` via DI for array validation (e.g., min/max items selected).
   *
   * @template T The **array type** holding the selected values (e.g., `string[]`).
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial selected array (`T`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedMultiSelectStateOptions`), including the required `options` function
   * and the `validation` property (accepting `ArrayValidatorOptions`). **Note:** `opt` is required.
   * @returns A `MultiSelectState` instance managing the control's reactive state.
   */
  return <T extends any[], TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedMultiSelectStateOptions<T>,
  ): MultiSelectState<T, TParent> => {
    const validation = computed(() => ({
      minLength: 0,
      maxLength: Infinity,
      ...opt.validation?.(),
    }));

    const mergedValidator = computed(() => validators.array.all(validation()));

    const validator = computed(() => {
      const merged = mergedValidator();

      return (value: T) => {
        return merged(value);
      };
    });

    const required = computed(() => validation().minLength > 0);

    const state = createMultiSelectState(value, {
      ...opt,
      required,
      validator,
    });

    const resolvedError = computed(() => {
      const merger = mergedValidator();

      return merger.resolve(state.errorTooltip() || state.error());
    });

    return {
      ...state,
      error: computed(() => resolvedError().error),
      errorTooltip: computed(() => resolvedError().tooltip),
    };
  };
}
