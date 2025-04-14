import { computed, type Signal } from '@angular/core';
import {
  type CreateFormControlOptions,
  type DerivedSignal,
  formControl,
  type FormControlSignal,
} from '@mmstack/form-core';
import { injectValidators } from '@mmstack/form-validation';
import { tooltip } from '../util';

/**
 * Represents the reactive state for a single-selection form control, such as
 * a dropdown/select menu (`<select>`, `<mat-select>`) or a radio button group (`<mat-radio-group>`).
 *
 * Extends `FormControlSignal<T>` where `T` is the type of the selected option's value
 * (typically non-nullable for single select). It adds properties specific to selection:
 * - `options`: A reactive list of available options with computed labels and disabled states.
 * - `valueLabel`: The display label of the currently selected value.
 * - `equal`: The function used for comparing option values.
 *
 * @template T The type of the individual option values (e.g., string, number, object).
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see FormControlSignal
 * @see SelectStateOptions
 * @see MultiSelectState (for multiple selections)
 * @see ButtonGroupState (for button-based single selection)
 */
export type SelectState<T, TParent = undefined> = FormControlSignal<
  T,
  TParent
> & {
  /** signal for error tooltip, default is shortened when error is longer than 40 chars */
  errorTooltip: Signal<string>;
  /** signal for hint tooltip, default is shortened when hint is longer than 40 chars */
  hintTooltip: Signal<string>;
  /** Signal holding the placeholder text (e.g., "Select an option...", "Choose one"). */
  placeholder: Signal<string>;
  /**
   * Signal holding the reactive array of available options suitable for rendering in the UI.
   * Each option object within the array contains:
   * - `id`: A unique string identifier derived using the `identify` function (crucial for tracking).
   * - `value`: The original option value of type `T`.
   * - `label`: A signal containing the display string derived using the `display` function.
   * - `disabled`: A signal indicating if this specific option should be disabled (based on the `disableOption` function and the control's overall disabled/readonly state).
   * This list dynamically ensures the currently selected `value()` is always present, even if removed from the source `options` array temporarily.
   */
  options: Signal<
    { id: string; value: T; label: Signal<string>; disabled: Signal<boolean> }[]
  >;
  /** Signal holding the display label of the currently selected `value()`, generated using the `display` function. */
  valueLabel: Signal<string>;
  /**
   * The equality function used internally by the underlying `FormControlSignal` to compare option values (`T`).
   * By default, it compares the string IDs generated by the `identify` function.
   * This can be overridden by providing a custom `equal` function in `SelectStateOptions`.
   * Crucial for determining change state, especially with object values.
   */
  equal: (a: T, b: T) => boolean;
  /** Type discriminator for single-select controls. */
  type: 'select';
};

/**
 * Configuration options required by the `createSelectState` function.
 * Extends base form control options for a selected value of type `T`.
 * Requires providing the list of available options and functions to identify/display them.
 *
 * @template T The type of the individual option values.
 * @see CreateFormControlOptions
 * @see createSelectState
 */
export type SelectStateOptions<T> = CreateFormControlOptions<T, 'control'> & {
  /** Optional function returning the placeholder text for the select input (e.g., "Please select..."). */
  placeholder?: () => string;
  /**
   * Optional function to generate a unique string identifier for a given option value `T`.
   * **Highly recommended** if `T` is an object or if default string coercion (`${value}`)
   * is not sufficient for unique identification.
   * This ID is used for the default `equal` comparison logic and internal option tracking.
   * @param value The option value of type `T`.
   * @returns A unique string ID for that value.
   * @example identify: () => (user) => user.id // Use user's ID property
   */
  identify?: () => (value: NoInfer<T>) => string;
  /**
   * Optional function to generate the display label string for a given option value `T`.
   * This label is shown in the options list and for the selected value (`valueLabel`).
   * Defaults to simple string coercion (`${value}`).
   * @param value The option value of type `T`.
   * @returns The string label to display in the UI.
   * @example display: () => (user) => user.name // Display user's name property
   */
  display?: () => (value: NoInfer<T>) => string;
  /**
   * Optional function to determine if a specific option `T` should be presented as disabled
   * in the selection list. Called for each option.
   * Defaults to `() => false` (no options disabled by default).
   * Note: An option corresponding to the currently selected value will never be disabled by this logic.
   * @param value The option value of type `T`.
   * @returns `true` if the option should be disabled, `false` otherwise.
   * @example disableOption: () => (user) => user.isArchived // Disable archived users
   */
  disableOption?: () => (value: NoInfer<T>) => boolean;
  /**
   * **Required**. A function that returns the array of available option values (`T[]`).
   * This function can return a dynamic list if needed, as it will be re-evaluated reactively.
   */
  options: () => T[];
  /* shortens error/hint message & provides errorTooltip with full message, default 40 */
  maxErrorHintLength?: () => number;
};

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateSelectState`.
 *
 * Extends `SelectStateOptions` but omits base properties handled internally by the
 * injected factory (`validator`, `required`). Allows specifying basic `required`
 * validation via the simplified `validation` property.
 *
 * @template T The type of the individual option values.
 * @see injectCreateSelectState
 * @see SelectStateOptions
 */
export type InjectedSelectStateOptions<T> = Omit<
  SelectStateOptions<T>,
  'required' | 'validator' // Properties handled internally
> & {
  /**
   * Optional function returning validation configuration.
   * Currently, only supports the `required` flag for select controls.
   * The factory uses this with the injected `validators.general.required()` method.
   */
  validation?: () => {
    /** If `true`, applies the `validators.general.required()` validator. */
    required?: boolean;
    // Note: Complex validation on the selected value T may require
    // external validation logic or a custom validator via createSelectState.
  };
};

/**
 * Creates the reactive state object (`SelectState`) for a single-select form control
 * without relying on Angular's dependency injection for validation.
 *
 * Handles the logic for identifying options, generating display labels, managing disabled
 * states, and ensuring the selected value is always represented in the options list.
 *
 * Use this function directly only if creating state outside an injection context or
 * providing a fully custom `validator` manually via `opt`. Prefer `injectCreateSelectState`
 * for standard usage, especially for easy `required` validation.
 *
 * @template T The type of the individual option values.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @param value The initial selected value (`T`), or a `DerivedSignal` linking it to a parent state.
 * Should typically be non-nullable unless `null` represents a valid selection state.
 * @param opt Configuration options (`SelectStateOptions`). **Note:** This parameter (and specifically `opt.options`) is required.
 * @returns A `SelectState` instance managing the control's reactive state.
 * @see injectCreateSelectState
 * @see SelectStateOptions
 */
export function createSelectState<T, TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: SelectStateOptions<T>,
): SelectState<T, TParent> {
  const identify = computed(
    () =>
      opt.identify?.() ??
      ((v: T) => {
        if (v === null || v === undefined) return '';
        return `${v}`;
      }),
  );

  const equal = (a: T, b: T) => {
    return identify()(a) === identify()(b);
  };

  const state = formControl<T, TParent>(value, {
    ...opt,
    equal: opt.equal ?? equal,
  });

  const display = computed(() => opt.display?.() ?? ((v: T) => `${v}`));

  const disableOption = computed(() => opt.disableOption?.() ?? (() => false));

  const valueId = computed(() => identify()(state.value()));
  const valueLabel = computed(() => display()(state.value()));

  const identifiedOptions = computed(() => {
    const identityFn = identify();

    return opt.options().map((value) => ({
      value,
      id: identityFn(value),
    }));
  });

  const allOptions = computed(() => {
    return identifiedOptions().map((o) => ({
      ...o,
      label: computed(() => display()(o.value)),
      disabled: computed(() => {
        if (valueId() === o.id) return false;
        return state.disabled() || state.readonly() || disableOption()(o.value);
      }),
    }));
  });

  const options = computed(() => {
    const currentId = valueId();

    const opt = allOptions();
    if (!currentId) return opt;
    if (opt.length && opt.some((o) => o.id === currentId)) return opt;

    return [
      ...opt,
      {
        id: currentId,
        value: state.value(),
        label: valueLabel,
        disabled: computed(() => false),
      },
    ];
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
    type: 'select',
  };
}

/**
 * Creates and returns a factory function for generating `SelectState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`) primarily
 * to simplify the application of basic `required` validation via the `validation` option.
 * It passes other configuration options (`options`, `identify`, `display`, etc.)
 * through to the underlying `createSelectState` function.
 *
 * This is the **recommended** way to create `SelectState` within an Angular application.
 *
 * @returns A factory function: `(value: T | DerivedSignal<TParent, T>, opt: InjectedSelectStateOptions<T>) => SelectState<T, TParent>`.
 * @template T The type of the individual option values used by the factory.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 *
 * @example
 * // Within an injection context:
 * const createSelect = injectCreateSelectState();
 *
 * // Example with simple string options
 * const themeOptions = ['light', 'dark', 'auto'] as const;
 * type Theme = typeof themeOptions[number];
 * const themeState = createSelect<Theme>('auto', { // Explicit T = Theme
 * label: () => 'Color Theme',
 * options: () => [...themeOptions], // Provide the options array
 * // No validation needed
 * });
 *
 * // Example with objects and required validation
 * type User = { id: string; displayName: string };
 * const userList: User[] = [{ id: 'u1', displayName: 'Alice' }, { id: 'u2', displayName: 'Bob' }];
 * const assigneeState = createSelect<User | null>(null, { // Explicit T = User | null
 * label: () => 'Assignee',
 * placeholder: () => 'Select an assignee',
 * options: () => userList,
 * identify: () => user => user?.id ?? '', // Use id for comparison
 * display: () => user => user?.displayName ?? 'None', // Use name for display
 * validation: () => ({ required: true }) // Easily add required validation
 * });
 */
export function injectCreateSelectState() {
  const validators = injectValidators();

  /**
   * Factory function (returned by `injectCreateSelectState`) that creates `SelectState`.
   * Integrates with `@mmstack/form-validation` via DI for basic `required` validation.
   *
   * @template T The type of the individual option values.
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial selected value (`T`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedSelectStateOptions`), including the required `options` function
   * and other select-specific settings like `identify`, `display`, plus the simplified `validation` property.
   * **Note:** The `opt` parameter itself is required.
   * @returns A `SelectState` instance managing the control's reactive state.
   */
  return <T, TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedSelectStateOptions<T>,
  ): SelectState<T, TParent> => {
    const label = computed(() => opt.label?.() ?? '');

    const required = computed(() => opt.validation?.()?.required ?? false);

    const validator = computed(() =>
      required() ? validators.general.required(label()) : () => '',
    );

    return createSelectState(value, {
      ...opt,
      required,
      validator,
      label,
    });
  };
}
