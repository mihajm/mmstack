import { type HttpResourceRequest } from '@angular/common/http';
import { computed, type Signal, type WritableSignal } from '@angular/core';
import {
  type CreateFormControlOptions,
  type DerivedSignal,
  formControl,
  type FormControlSignal,
} from '@mmstack/form-core';
import { injectValidators } from '@mmstack/form-validation';
import { debounced } from '@mmstack/primitives';
import { tooltip } from '../util';

/**
 * Represents the reactive state for an asynchronous search-and-select form control.
 *
 * Designed for scenarios where users type a query, triggering an asynchronous request
 * (usually HTTP) to fetch matching results, from which the user selects a single item.
 *
 * Extends `FormControlSignal<T>` where `T` is the type of the **selected** item.
 * Key features:
 * - `query`: Debounced signal holding the user's search text.
 * - `request`: Signal computing the request needed to fetch results based on the query.
 * - `identify`/`displayWith`: Functions for handling the selected item's ID and label.
 * - `onSelected`: Callback invoked when an item is selected from results.
 *
 * **Note:** This state adapter **does not** manage the search results list itself.
 * The component using this state is responsible for executing the request derived
 * from the `request` signal (e.g., using `httpResource` `@mmstack/resource` or `HttpClient`) and
 * displaying the results to the user.
 *
 * @template T The type of the **selected** item value. Usually non-nullable once an item is selected.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see FormControlSignal
 * @see SearchStateOptions
 */
export type SearchState<T, TParent = undefined> = FormControlSignal<
  T, // Represents the currently selected item (type T)
  TParent
> & {
  /** signal for error tooltip, default is shortened when error is longer than 40 chars */
  errorTooltip: Signal<string>;
  /** signal for hint tooltip, default is shortened when hint is longer than 40 chars */
  hintTooltip: Signal<string>;
  /** Signal holding the placeholder text for the search input field (e.g., "Search users..."). */
  placeholder: Signal<string>;
  /**
   * Signal holding the function used to extract a unique string identifier from a selected item `T`.
   * Crucial for the default `equal` comparison logic. Defaults to string coercion.
   */
  identify: Signal<(item: NoInfer<T>) => string>;
  /**
   * Signal holding the function used to extract the display string label from a selected item `T`.
   * Used by `valueLabel` and potentially by the UI displaying the selected item. Defaults to string coercion.
   */
  displayWith: Signal<(item: NoInfer<T>) => string>;
  /**
   * Signal holding the function used to determine if a potential result item `T` (returned from the search)
   * should be disabled and non-selectable in the UI list. Defaults to `() => false`.
   */
  disableOption: Signal<(item: NoInfer<T>) => boolean>;
  /**
   * A debounced writable signal representing the user's current search query text.
   * Bind the search text input's value changes to this signal's `.set()` method.
   * Changes to this signal (after debouncing) trigger updates to the `request` signal.
   */
  query: WritableSignal<string>;
  /**
   * A signal that reactively computes the necessary HTTP request configuration
   * (e.g., `{ url: string, params?: HttpParams }` or a custom `HttpResourceRequest` type)
   * based on the current debounced `query()` signal, using the `toRequest` function provided in options.
   * It returns `undefined` if no request should be made (e.g., query too short, control disabled/readonly).
   * This signal should be observed by data-fetching logic to trigger API calls for search results.
   */
  request: Signal<HttpResourceRequest | undefined>;
  /** Type discriminator for asynchronous search controls. */
  type: 'search';
  /** Signal holding the display label of the currently selected `value()`, derived using the `displayWith` function. */
  valueLabel: Signal<string>;
  /** Signal holding the unique string ID of the currently selected `value()`, derived using the `identify` function. */
  valueId: Signal<string>;
  /**
   * Callback function provided via options, intended to be called by the consuming UI component
   * when the user selects an item (`T`) from the search results list. Allows performing actions
   * upon selection (e.g., storing state in localStorage, clearing the query, closing a panel). Defaults to a no-op function.
   * @param value The selected item of type `T`.
   */
  onSelected: (value: T) => void;
};

/**
 * Configuration options required by the `createSearchState` function.
 * Extends base form control options for the selected value of type `T`.
 * Requires the `toRequest` function for defining the search API call, and typically
 * requires `identify` and `displayWith` for handling the selected object `T`.
 *
 * @template T The type of the item being searched for and selected.
 * @see CreateFormControlOptions
 * @see createSearchState
 */
export type SearchStateOptions<T> = CreateFormControlOptions<T, 'control'> & {
  /** Optional function returning the placeholder text for the search input field. */
  placeholder?: () => string;
  /**
   * Optional function to generate a unique string identifier for a given item `T`.
   * **Highly recommended** for object values. Used for default equality checks and `valueId`.
   * Defaults to string coercion (`${value}`).
   * @param item An item of type `T`.
   * @returns A unique string ID.
   */
  identify?: () => (item: NoInfer<T>) => string;
  /**
   * Optional function to generate the display label string for a given item `T`.
   * Used for `valueLabel` and typically for displaying items in search results.
   * Defaults to string coercion (`${value}`).
   * @param item An item of type `T`.
   * @returns The string label to display.
   */
  displayWith?: () => (item: NoInfer<T>) => string;
  /**
   * Optional function to determine if a specific item `T` (e.g., from search results)
   * should be disabled for selection in the UI list. Defaults to `() => false`.
   * @param item An item of type `T`.
   * @returns `true` if the item should be disabled.
   */
  disableOption?: () => (item: NoInfer<T>) => boolean;
  /**
   * **Required**. Function that returns another function responsible for mapping the current
   * debounced search `query` string to an HTTP request configuration object (like `HttpResourceRequest`
   * or any type your data fetching layer expects).
   * The inner function should return `undefined` if no request should be triggered for the given query
   * (e.g., query is empty or too short). This drives the `request` signal.
   * @returns `(query: string) => HttpResourceRequest | undefined`
   * @example
   * // Fetch users from API based on query
   * toRequest: () => (query) => {
   * if (!query || query.length < 2) return undefined;
   * return { url: '/api/users', params: { search: query } };
   * }
   */
  toRequest: () => (query: string) => HttpResourceRequest | undefined; // Adjust HttpResourceRequest type if needed
  /**
   * Optional callback function executed by the consuming UI component when an item `T`
   * is selected from the search results. Use this for side effects upon selection.
   * @param value The selected item of type `T`.
   */
  onSelected?: (value: T) => void;
  /**
   * Optional debounce time in milliseconds for the `query` signal before the `request` signal updates.
   * Helps prevent excessive API calls while typing. Uses `@mmstack/primitives` `debounced`.
   * Defaults to 0 (or the default of `debounced`).
   * @example debounce: 300 // Debounce for 300ms
   */
  debounce?: number;
  /* shortens error/hint message & provides errorTooltip with full message, default 40 */
  maxErrorHintLength?: () => number;
};

/**
 * Configuration options specifically for the factory function returned by
 * `injectCreateSearchState`.
 *
 * Extends `SearchStateOptions` but omits base properties handled internally
 * (`validator`, `required`). Allows specifying basic `required` validation
 * via the simplified `validation` property (checks if an item `T` is selected).
 *
 * @template T The type of the item being searched for and selected.
 * @see injectCreateSearchState
 * @see SearchStateOptions
 */
export type InjectedSearchStateOptions<T> = Omit<
  SearchStateOptions<T>,
  'required' | 'validator' // Properties handled internally
> & {
  /**
   * Optional function returning validation configuration. Currently only supports `required`.
   * The factory uses this with the injected `validators.general.required()` method to check
   * if a value (`T`) has been selected (i.e., the control value is not `null` or `undefined`).
   */
  validation?: () => {
    /** If `true`, applies the `validators.general.required()` validator to the selected value. */
    required?: boolean;
  };
};

/**
 * Creates the reactive state object (`SearchState`) for an async search-and-select control
 * without relying on Angular's dependency injection for validation.
 *
 * Manages the debounced search query (`query`), computes the necessary request object (`request`),
 * and provides helpers (`identify`, `displayWith`, `valueLabel`, `valueId`, `onSelected`)
 * for handling the selected item (`T`). It does **not** manage the search results list.
 *
 * Prefer `injectCreateSearchState` for easier `required` validation integration within Angular.
 *
 * @template T The type of the item being searched for and selected.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @param value The initial selected value (`T`), or a `DerivedSignal` linking it to a parent state. Often initialized to `null` or a default object.
 * @param opt Configuration options (`SearchStateOptions`). **Note:** This parameter (and `opt.toRequest`) is required.
 * @returns A `SearchState` instance managing the control's reactive state.
 * @see injectCreateSearchState
 * @see SearchStateOptions
 */
export function createSearchState<T, TParent = undefined>(
  value: T | DerivedSignal<TParent, T>,
  opt: SearchStateOptions<T>,
): SearchState<T, TParent> {
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

  const query = debounced('', { ms: opt.debounce });

  const displayWith = computed(() => opt.displayWith?.() ?? ((v: T) => `${v}`));

  const disableOption = computed(() => opt.disableOption?.() ?? (() => false));

  const toRequest = computed(() => opt.toRequest());

  const onSelected =
    opt.onSelected ??
    (() => {
      // noop
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
    placeholder: computed(() => opt.placeholder?.() ?? ''),
    identify,
    displayWith,
    disableOption,
    query,
    request: computed(() => {
      if (state.disabled() || state.readonly()) return;

      return toRequest()(query());
    }),
    valueLabel: computed(() => displayWith()(state.value())),
    valueId: computed(() => identify()(state.value())),
    onSelected,
    error,
    errorTooltip,
    hint,
    hintTooltip,
    type: 'search',
  };
}

/**
 * Creates and returns a factory function for generating `SearchState` instances.
 *
 * This factory utilizes Angular's dependency injection (`injectValidators`) primarily
 * to simplify the application of basic `required` validation (checking if an item `T`
 * has been selected) via the `validation` option. It passes other configuration
 * (`toRequest`, `identify`, `displayWith`, etc.) through to the underlying `createSearchState`.
 *
 * This is the **recommended** way to create `SearchState` within an Angular application.
 *
 * @returns A factory function: `(value: T | DerivedSignal<TParent, T>, opt: InjectedSearchStateOptions<T>) => SearchState<T, TParent>`.
 * @template T The type of the item being searched for and selected.
 * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
 * @see createSearchState
 * @see InjectedSearchStateOptions
 *
 * @example
 * // Within an injection context:
 * const createSearch = injectCreateSearchState();
 *
 * interface User { id: string; name: string }
 *
 * const userSearchState = createSearch<User | null>(null, {
 * label: () => 'Select User',
 * placeholder: () => 'Search by name...',
 * identify: () => user => user?.id ?? '',
 * displayWith: () => user => user?.name ?? '',
 * // Define how to create the search request from the query
 * toRequest: () => (query) => query ? ({ url: '/api/users', params: { q: query } }) : undefined,
 * validation: () => ({ required: true }), // Ensure a user is selected
 * debounce: 300 // Debounce API calls
 * });
 *
 */
export function injectCreateSearchState() {
  const validators = injectValidators();

  /**
   * Factory function (returned by `injectCreateSearchState`) that creates `SearchState`.
   * Integrates with `@mmstack/form-validation` via DI primarily for `required` validation.
   *
   * @template T The type of the item being searched for and selected.
   * @template TParent The type of the parent form group's value, if applicable. Defaults to `undefined`.
   * @param value The initial selected value (`T`), or a `DerivedSignal` linking it to a parent state.
   * @param opt Configuration options (`InjectedSearchStateOptions`), including the required `toRequest` function
   * and the simplified `validation` property. **Note:** `opt` is required.
   * @returns A `SearchState` instance managing the control's reactive state.
   */
  return <T, TParent = undefined>(
    value: T | DerivedSignal<TParent, T>,
    opt: InjectedSearchStateOptions<T>,
  ) => {
    const label = computed(() => opt.label?.() ?? '');
    const validation = computed(() => ({
      required: false,
      ...opt.validation?.(),
    }));

    const required = computed(() => validation().required);

    const validator = computed(() =>
      required() ? validators.general.required(label()) : () => '',
    );

    return createSearchState(value, { ...opt, required, validator, label });
  };
}
