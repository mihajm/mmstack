# @mmstack/form-adapters

Provides a collection of **headless, reusable state adapters** for common form field types. Built upon [@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core) and integrating with [@mmstack/form-validation](https://www.npmjs.com/package/@mmstack/form-validation), this library allows you to define reactive form state logic independently from any specific UI component library.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fobject.svg)](https://badge.fury.io/js/%40mmstack%2Fobject)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/form/adapters/LICENSE)

Use these adapters to manage state for inputs like text fields, selects, date pickers, checkboxes, etc., and then bind that state to your chosen UI components. They are extended & re-exported by specific ui libraries like [@mmstack/form-material](https://www.npmjs.com/package/@mmstack/form-material).

## Installation

```bash
npm install @mmstack/form-adapters @mmstack/form-core @mmstack/form-validation
```

## Core Concept: State Adapters

Each "adapter" represents the complete reactive state for a specific type of form field. It bundles the core signals (`value`, `error`, `disabled`, `touched`, `label`, `hint` etc.) from `@mmstack/form-core`'s `FormControlSignal` with additional signals, properties, and helper functions relevant to that field type (e.g., `placeholder` for text, `options` for select, `step` for number).

Key characteristics:

- **`XState` Type:** Each adapter exports a specific type (e.g., `StringState`, `SelectState<T>`) describing its structure, inheriting from `FormControlSignal`.
- **`type` Discriminator:** State objects include a `type` property (e.g., `{ type: 'string' }`, `{ type: 'select' }`) for easy identification in code or templates.
- **Creation Factories:** Each adapter provides functions to create instances of its state object, typically with and without relying on Angular's Dependency Injection.

## `createXState` vs `injectCreateXState`

All adapters offer two ways to create their state object:

### `createXState(...)`

- **Pure function:** Does **not** use Angular's Dependency Injection (DI).
- Requires manual configuration, including providing a complete `validator` function via its options if validation is needed.
- **Use Case:** Useful when creating state outside an Angular injection context, or when you need absolute control over validator creation without using `@mmstack/form-validation`'s DI features.

### `injectCreateXState()`

- **DI-based:** Returns a factory function that **uses** Angular's DI (specifically `injectValidators` from `@mmstack/form-validation` and often `LOCALE_ID`).
- Offers a convenient API accepting simplified `validation` options (e.g., `{ validation: () => ({ required: true, minLength: 5 }) }`) which use the corresponding `XxxValidatorOptions` type from `@mmstack/form-validation`.
- Automatically creates the final `validator` function using globally configured (and potentially localized) validation rules.
- May provide enhanced features like error message/tooltip splitting.
- **Use Case:** The **recommended approach** within Angular applications for easy integration with validation and localization.

## Available Adapters

This library provides state adapters for various common form field types:

| Adapter Type     | State Type Export                | Value Type       | Key Added Properties/Signals                                                                                | Creation Functions                                         |
| :--------------- | :------------------------------- | :--------------- | :---------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| **String**       | `StringState<TParent>`           | `string \| null` | `placeholder`, `autocomplete`                                                                               | `createStringState`, `injectCreateStringState`             |
| **Textarea**     | `TextareaState<TParent>`         | `string \| null` | `placeholder`, `autocomplete`, `rows`, `minRows`, `maxRows`                                                 | `createTextareaState`, `injectCreateTextareaState`         |
| **Autocomplete** | `AutocompleteState<TParent>`     | `string \| null` | `placeholder`, `autocomplete`, `options` (filtered string[]), `displayWith`                                 | `createAutocompleteState`, `injectCreateAutocompleteState` |
| **Number**       | `NumberState<TParent>`           | `number \| null` | `placeholder`, `step`, `localizedValue`, `setLocalizedValue`, `inputType`, `keydownHandler`                 | `createNumberState`, `injectCreateNumberState`             |
| **Date**         | `DateState<TParent, TDate>`      | `TDate \| null`  | `placeholder`, `min`, `max`                                                                                 | `createDateState`, `injectCreateDateState`                 |
| **Time**         | `TimeState<TParent, TDate>`      | `TDate \| null`  | `placeholder`, `min`, `max`                                                                                 | `createTimeState`, `injectCreateTimeState`                 |
| **DateTime**     | `DateTimeState<TParent, TDate>`  | `TDate \| null`  | `placeholder`, `min`, `max`, `timeControl`, `dateControl`                                                   | `createDateTimeState`, `injectCreateDateTimeState`         |
| **Boolean**      | `BooleanState<TParent>`          | `boolean`        | (Type discriminator)                                                                                        | `createBooleanState`, `injectCreateBooleanState`           |
| **Toggle**       | `ToggleState<TParent>`           | `boolean`        | (Type discriminator)                                                                                        | `createToggleState`, `injectCreateToggleState`             |
| **Select**       | `SelectState<T, TParent>`        | `T`              | `placeholder`, `options` (T[]), `valueLabel`, `identify`, `display`, `equal`                                | `createSelectState`, `injectCreateSelectState`             |
| **Multi-Select** | `MultiSelectState<T[], TParent>` | `T[]`            | `placeholder`, `options` (T[number][]), `valueLabel` (joined), `identify`, `display` (elem), `equal` (elem) | `createMultiSelectState`, `injectCreateMultiSelectState`   |
| **Button Group** | `ButtonGroupState<T, TParent>`   | `T`              | `options` (T[]), `valueLabel`, `identify`, `display`, `equal` (inherits Select minus placeholder)           | `createButtonGroupState`, `injectCreateButtonGroupState`   |
| **Search**       | `SearchState<T, TParent>`        | `T`              | `placeholder`, `query`, `request`, `identify`, `displayWith`, `valueLabel`, `valueId`, `onSelected`         | `createSearchState`, `injectCreateSearchState`             |

_Refer to JSDoc comments for detailed descriptions of state properties and options._

## Usage Example (Using `injectCreate...`)

```typescript
// Example Factory Provider or Component logic
import { Component, computed, inject, signal, isSignal, type Signal } from '@angular/core';
import { formGroup, derived, type DerivedSignal } from '@mmstack/form-core';
import {
  // Import desired adapter factories and state types
  injectCreateStringState,
  StringState,
  injectCreateNumberState,
  NumberState,
  injectCreateSelectState,
  SelectState,
  injectCreateBooleanState,
  BooleanState,
  // ... import other needed adapter types and factories
} from '@mmstack/form-adapters';
// Validation options come from @mmstack/form-validation
import { StringValidatorOptions, NumberValidatorOptions } from '@mmstack/form-validation';

// Assume Validation is configured globally via provideValidatorConfig

interface Settings {
  notifyByEmail: boolean;
  email: string | null;
  maxItems: number | null;
  defaultView: 'list' | 'grid';
}

// Factory function using injected adapters
function injectSettingsFormState<TParent = undefined>(
  // Can accept raw value, signal, or derived signal
  initialValue: Settings | DerivedSignal<TParent, Settings> = { notifyByEmail: true, email: null, maxItems: 10, defaultView: 'list' },
) {
  // Get injected factories within an injection context
  const createBoolean = injectCreateBooleanState();
  const createString = injectCreateStringState();
  const createNumber = injectCreateNumberState();
  const createSelect = injectCreateSelectState();

  // Ensure we have a WritableSignal (or DerivedSignal) for formGroup
  const settingsSignal = isSignal(initialValue) ? initialValue : signal(initialValue); // Create a signal if raw value passed

  // Create the form group using derived controls
  return formGroup(settingsSignal, {
    // Use derived() to link child state to parent signal properties
    notifyByEmail: createBoolean(derived(settingsSignal, 'notifyByEmail'), {
      label: () => 'Notify by Email',
      // No validation for boolean here
    }),

    // Conditionally validate email based on the notifyByEmail flag
    email: createString(derived(settingsSignal, 'email'), {
      label: () => 'Notification Email',
      // Validation rules depend on another control's value from the PARENT signal
      validation: () => ({
        // Only require email if notifications are enabled
        required: settingsSignal().notifyByEmail, // Read from parent signal
        pattern: settingsSignal().notifyByEmail ? 'email' : undefined,
      }),
    }),

    maxItems: createNumber(derived(settingsSignal, 'maxItems'), {
      label: () => 'Max Items per Page',
      validation: () => ({ required: true, min: 5, max: 100, integer: true }),
    }),

    defaultView: createSelect<'list' | 'grid'>(derived(settingsSignal, 'defaultView'), {
      label: () => 'Default View',
      options: () => ['list', 'grid'],
      display: () => (value) => value === 'list' ? 'List view' : 'Grid view'
      // Add required validation for the select
      validation: () => ({ required: true }),
    }),
  });
}
```

## Validation Integration

The `injectCreateXState` factories are designed to work seamlessly with [@mmstack/form-validation](https://www.npmjs.com/package/@mmstack/form-validation). Pass a `validation` function in the options object. This function should return the appropriate `XxxValidatorOptions` object (e.g., `StringValidatorOptions`, `NumberValidatorOptions`, `ArrayValidatorOptions` for MultiSelect). The factory uses the injected `validators` service to create the final validation logic, respecting global configuration like localization.

```typescript
// Example: Get factory and configure validation
const createNum = injectCreateNumberState();
const countState = createNum(0, {
  label: () => 'Count',
  // Pass NumberValidatorOptions via the validation function
  validation: () => ({ required: true, min: 0, max: 10 }),
});
```

## Using Adapters with UI Components

This library provides only the reactive state (**headless**). You need separate UI components (from libraries like [@mmstack/form-material](https://www.npmjs.com/package/@mmstack/form-material), Angular Material itself, PrimeNG, Bootstrap, etc., or your own custom components) to render the actual form fields.

These UI components would typically:

1.  Accept the corresponding `XState` object as an `@Input()`.
2.  Bind their internal HTML elements (e.g., `<input>`, `<select>`, `<mat-select>`) to the signals and properties provided by the state object (`state.value`, `state.label`, `state.placeholder`, `state.disabled`, `state.error`, `state.options`, etc.).
3.  Call state methods like `state.value.set()` or `state.markAsTouched()` in response to user interactions.

## `SignalErrorValidator` Directive

This library also exports `SignalErrorValidator`, a directive useful for integrating the `error()` signal from any form state adapter with template-driven forms (`ngModel`), particularly when using UI component libraries like Angular Material's `<mat-form-field>` that rely on `NgControl`'s validation status derived from `ngModel`. Bind the state's `error()` signal to the `[mmSignalError]` input on an element that also has `ngModel`.

```html
<input matInput [(ngModel)]="myStringState.value" [mmSignalError]="myStringState.error()" (blur)="myStringState.markAsTouched()" #myNgModel="ngModel" /> <mat-error>{{ myStringState.error() }}</mat-error>
```

Refer to the JSDoc for `SignalErrorValidator` for more details.

## Contributing

Contributions, issues, and feature requests are welcome!
