import { computed, Signal } from '@angular/core';
import {
  type CreateFormControlOptions,
  type DerivedSignal,
  formControl,
  type FormControlSignal,
} from '@mmstack/form-core';
import {
  injectValidators,
  type StringValidatorOptions,
} from '@mmstack/form-validation';

/**
 * Represents the reactive state for a basic string input form control
 * (e.g., <input type="text">, <input type="email">, <input type="password">).
 *
 * Extends `FormControlSignal<string | null>` with properties relevant to string inputs
 * like `placeholder`, HTML `autocomplete` attribute handling, and enhanced error display.
 * For multi-line text inputs, see `TextareaState`. For inputs with suggestions, see `AutocompleteState`.
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see FormControlSignal
 * @see TextareaState
 * @see AutocompleteState
 */
export type StringState<TParent = undefined> = FormControlSignal<
  string | null,
  TParent
> & {
  /**
   * Signal holding the value for the HTML `autocomplete` attribute (e.g., 'on', 'off', 'email', 'name').
   * Defaults to 'off'. Bind using `[autocomplete]="state.autocomplete()"`.
   */
  autocomplete: Signal<AutoFill>;
  /** Signal holding the input placeholder text (e.g., "Enter your name"). */
  placeholder: Signal<string>;
  /**
   * Signal holding the formatted error message suitable for tooltips or detailed display.
   * When multiple validation errors occur, this may contain all messages, while `error()` might show a summary.
   * Populated by `injectCreateStringState` using the validator's `.resolve()` method.
   */
  errorTooltip: Signal<string>;
  /** Type discriminator for basic string input controls. */
  type: 'string';
};

/**
 * Configuration options for the `createStringState` function (the non-DI version).
 * Extends base form control options for a `string | null` value.
 *
 * @see CreateFormControlOptions
 * @see createStringState
 */
export type StringStateOptions = CreateFormControlOptions<
  string | null,
  'control'
> & {
  /**
   * Optional function returning the value for the HTML `autocomplete` attribute.
   * Defaults to `() => 'off'`.
   */
  autocomplete?: () => AutoFill;
  /** Optional function returning the placeholder text for the string input. */
  placeholder?: () => string;
};

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateStringState`.
 *
 * Omits base properties handled by the factory (`validator`, `required`) and requires
 * validation rules via the `validation` property using `StringValidatorOptions`.
 *
 * @see injectCreateStringState
 * @see StringStateOptions
 * @see StringValidatorOptions
 */
export type InjectedStringStateOptions = Omit<
  StringStateOptions,
  'required' | 'validator' // Properties handled internally
> & {
  /**
   * Optional function returning a `StringValidatorOptions` object defining the validation rules.
   * The factory uses this configuration with the injected `validators.string.all()` method.
   * @example validation: () => ({ required: true, maxLength: 100, pattern: 'email' })
   */
  validation?: () => StringValidatorOptions;
};

/**
 * Creates the reactive state object (`StringState`) for a string form control
 * without relying on Angular's dependency injection for validation.
 *
 * Use this function directly only if creating state outside an injection context or
 * providing a fully custom `validator` manually via the `opt` parameter.
 * Prefer `injectCreateStringState` for standard usage within Angular applications
 * to easily integrate with the validation system.
 *
 * Note: The `errorTooltip` signal returned by this function will initially be empty.
 *
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @param value The initial string value (`string | null`), or a `DerivedSignal` linking it to a parent state.
 * @param opt Optional configuration options (`StringStateOptions`).
 * @returns A `StringState` instance managing the control's reactive state.
 * @see injectCreateStringState
 */
export function createStringState<TParent = undefined>(
  value: string | null | DerivedSignal<TParent, string | null>,
  opt?: StringStateOptions,
): StringState<TParent> {
  const state = formControl<string | null, TParent>(value, opt);

  return {
    ...state,
    autocomplete: computed(() => opt?.autocomplete?.() ?? 'off'),
    placeholder: computed(() => opt?.placeholder?.() ?? ''),
    errorTooltip: computed(() => ''),
    type: 'string',
  };
}

/**
 * Creates and returns a factory function for generating `StringState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`)
 * to automatically handle validation configuration (via `StringValidatorOptions`
 * passed to the `validation` option) and enhanced error message formatting
 * (splitting merged errors into `error` and `errorTooltip` signals).
 *
 * This is the **recommended** way to create `StringState` within an Angular application.
 *
 * @returns A factory function: `(value: string | null | DerivedSignal<TParent, string | null>, opt?: InjectedStringStateOptions) => StringState<TParent>`.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 *
 * @example
 * // Within an injection context:
 * const createString = injectCreateStringState();
 *
 * const emailState = createString(null, {
 * label: () => 'Email',
 * placeholder: () => 'Enter your email address',
 * autocomplete: () => 'email',
 * validation: () => ({ required: true, pattern: 'email' }) // Use StringValidatorOptions
 * });
 *
 * // Template might use:
 * // <input type="email" [state]="emailState"> // If using a component that accepts StringState
 * // Or manually:
 * // <input type="email"
 * //   [value]="emailState.value()"
 * //   (input)="emailState.value.set($any($event.target).value)"
 * //   [placeholder]="emailState.placeholder()"
 * //   [autocomplete]="emailState.autocomplete()"
 * //   ... bind errors, disabled, readonly etc... />
 */
export function injectCreateStringState() {
  const validators = injectValidators();

  /**
   * Factory function (returned by `injectCreateStringState`) that creates `StringState`.
   * Integrates with `@mmstack/form-validation` via DI for validation and error handling.
   *
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial string value (`string | null`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedStringStateOptions`), including the `validation` property
   * which accepts `StringValidatorOptions`.
   * @returns A `StringState` instance managing the control's reactive state, including separate
   * `error` (for primary display) and `errorTooltip` (for detailed/multiple errors) signals.
   */
  return <TParent = undefined>(
    value: string | null | DerivedSignal<TParent, string | null>,
    opt?: InjectedStringStateOptions,
  ): StringState<TParent> => {
    const validationOptions = computed(() => ({
      messageOptions: {
        label: opt?.label?.(),
      },
      ...opt?.validation?.(),
    }));

    const mergedValidator = computed(() =>
      validators.string.all(validationOptions()),
    );

    const validator = computed(() => {
      const merged = mergedValidator();

      return (value: string | null) => {
        return merged(value);
      };
    });

    const state = createStringState(value, {
      ...opt,
      required: computed(() => opt?.validation?.()?.required ?? false),
      validator,
    });

    const resolvedError = computed(() => {
      const merger = mergedValidator();

      return merger.resolve(state.error());
    });

    return {
      ...state,
      error: computed(() => resolvedError().error),
      errorTooltip: computed(() => resolvedError().tooltip),
    };
  };
}
