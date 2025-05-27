# @mmstack/form-material: Angular Material Components & bindings for @mmstack signal forms

If you're using `@mmstack/form-core` and Angular Material, this library is the quickest way to build your forms.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fform-material.svg)](https://www.npmjs.com/package/@mmstack/form-material)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/form/material/LICENSE)

A library to bridge the gap between the declarative, signal-based form state management provided by [@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core) and [@mmstack/form-adapters](https://www.npmjs.com/package/@mmstack/form-adapters), and the rich UI components of [Angular Material](https://www.npmjs.com/package/@angular/material).

It offers a collection of reusable, standalone Angular components (e.g., `<mm-string-field>`, `<mm-select-field>`, `<mm-date-field>`) designed to directly consume the state objects (`StringState`, `SelectState`, `DateState`, etc.) from `@mmstack/form-adapters`.

**Features:**

- **Effortless Binding:** Directly bind your form state signals (`value`, `label`, `disabled`, `error`, etc.) to Material components.
- **Material Styling:** Uses standard Angular Material components (`mat-form-field`, `matInput`, `matSelect`, etc.) ensuring theme consistency.
- **Reduced Boilerplate:** Focus on your form logic, not the UI wiring.

## Manual Installation

1.  Install `@mmstack/form-core`.

    ```bash
    npm install @mmstack/form-core
    ```

2.  Add global styles to `styles` in `angular.json`

    ```json
    "targets": {
      "build": {
        "styles": [
          "node_modules/@mmstack/form-material/styles/globals.css"
        ]
      }
    }
    ```

## Core primitives

This library utilizes & re-exports [@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core). This core library provides fully signal-based & type-safe form primitives, which you can use to build your own forms or control components. You can read more about the philosophy of these primitives & why we created them here: [Fun-grained reactivity in Angular: Part 2 – Forms](https://dev.to/mihamulec/fun-grained-reactivity-in-angular-part-2-forms-e84)

[@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core) provides the foundational building blocks for the `@mmstack` signal-based forms ecosystem. It addresses the challenges of maintaining a predictable reactive graph when dealing with forms, especially with nested objects/arrays and the limitations of `[(ngModel)]` in a signal-based, zoneless, future.

The library focuses on ensuring that changes to any part of the form state properly trigger updates throughout the signal dependency graph, enabling fine-grained reactivity and avoiding unexpected mutations.

```typescript
derived<T, U>(
  source: WritableSignal<T>,
  options: {
    from: (v: T) => U,
    onChange: (newValue: U) => void
  }
): DerivedSignal<T, U>
```

There is also a helpful overload for pure objects/arrays:

```typescript
const value = signal({ name: 'John' });
const derivation = derived(value, 'name'); // WritableSignal<string>
```

This function creates a special WritableSignal<U> (a DerivedSignal) that represents a piece of data (U) derived from a parent WritableSignal<T> (source).

from: Extracts the child value (U) from the parent value (T).
onChange: Defines how to update the parent signal (source) when the derived signal's value is set.
Crucially, derived establishes a bi-directional reactive link:

Changes to the source signal automatically update the derived signal's value (like a computed).
Setting the derived signal's value uses the onChange function to update the source signal immutably, ensuring the change propagates correctly through the reactive graph.

This primitive is essential for creating form structures where changes to individual field controls reliably update the overall form state signal.

### Core Form Primitives (@mmstack/form-core)

Building upon derived and standard Angular Signals, the library offers three main primitives for structuring form state:

#### formControl<T, TParent = undefined>

This is the most basic building block, representing the state of a single input field. It wraps a value T, which can be a plain value/signal or, crucially, a DerivedSignal<TParent, T> linking it to a parent state. It manages the core form state signals like value. When initialized with a DerivedSignal, it ensures changes flow reactively between the control and its parent. This primitive serves as the foundation for more specialized field types defined in adapter libraries.

#### formGroup<T extends object, TDerivations extends Record<string, FormControlSignal<any, T, any, any>>, TParent = undefined>

Use formGroup to manage a structured collection of named controls, representing an object T (which is often derived from a TParent signal). It holds a children signal containing a map (TDerivations) where each value is a FormControlSignal. These child controls must be derived from the group's value T. The formGroup aggregates status (like valid, dirty, touched) while also controlling its own state. It efficiently propagates actions like markAllAsTouched or reconcile down to its children, utilizing the from property (inherited from their DerivedSignal inputs) to correctly update or reset them based on changes to the group's value.

#### formArray<T[], TIndividualState extends FormControlSignal<T, any, any, any>, TParent = undefined>

This primitive manages a dynamic list of controls, allowing controls to be added or removed at runtime. It takes an initial array value (plain or DerivedSignal<TParent, T>) and a factory function. This factory is key: it receives a DerivedSignal<T[], T> representing a single element's value and position within the array signal, and it returns the corresponding child FormControlSignal (TIndividualState). This ensures each child control is reactively and correctly linked to its specific element. formArray aggregates status, provides array manipulation methods (push, remove), signals like canAdd/canRemove, and features an optimized reconciliation mechanism that reuses existing child control instances when the array changes.

## Validation (@mmstack/form-validation)

Forms aren't complete without validation. `@mmstack/form-material` provides a built-in, type-safe, and localizable validation system, by re-exporting the generic [@mmstack/form-validation](https://www.npmjs.com/package/@mmstack/form-validation) library.

The validation library provides a way to generate type-safe & consisten error messages accross the various components for example:

```typescript
import { injectValidators } from '@mmstack/form-material';

export class DemoComponent {
  private readonly validators = injectValidators();

  demo1 = validators.general.required(); // validator which returns "Field is required" when called with null/undefined/empty value
  demo2 = validators.general.required('Name'); // validator which returns "Name is required" when called with null/undefined/empty value
  demo3 = validators.number.min(3); // validators which returns "Must be at least 3" when called with number less than 3
}
```

If you require localized messages, or would like to modify defaults you can do so easily by providing the message creation functions in your `app.config.ts`

```typescript
import { provideValidatorConfig } from '@mmstack/form-material';

export const appConfig: ApplicationConfig = {
  providers: [
    // ..rest

    // injects LOCALE_ID
    provideValidatorConfig<DateTime>(
      (locale) => {
        switch (locale) {
          case 'sl-SI':
            return {
              general: {
                required: () => 'To polje je obvezno', // provide localized validator
              },
            };
          default: {
            return {
              general: {
                // label variable is fully type-safe
                required: (label) => `This ${label} is required`,
              },
            };
          }
        }
      },
      // provide a custom toDate function if you're using non-date objects like Luxon's DateTime or Moment
      (dateTime) => dateTime.toJSDate();
    ),
  ],
};
```

## Form adapters (@mmstack/form-adapters)

The `@mmstack/form-adapters` library plays a crucial role in decoupling specific form field logic from any particular UI library implementation. It allows us to generalize state adapters so functions like `createStringState` are applicable whether you're using Angular Material, PrimeNG, Bootstrap, or your own custom components. These adapter primitives are available directly in the [@mmstack/form-adapters](https://www.npmjs.com/package/@mmstack/form-adapters) package but are also conveniently re-exported by `@mmstack/form-material`.

### Purpose

Adapters take the foundational primitives from `@mmstack/form-core` (primarily `formControl`) and enhance them to create standardized, type-specific state objects for common form field types (e.g., `StringState`, `NumberState`, `SelectState`, `DateState`).

These state objects bundle the core `FormControlSignal` properties (`value`, `error`, `touched`, etc.) with additional UI-relevant signals and configurations tailored to the field type, such as:

- `placeholder` (for text inputs)
- `options`, `valueLabel`, `equal` (for select/autocomplete)
- `min`, `max` (for date/number)
- `rows`, `autosize` (for textarea)
- A `type` discriminator (e.g., `'string'`, `'select'`) to allow us to dynamically assert control types in our logic/templates

By defining these common state shapes, UI integration libraries (like `@mmstack/form-material`) can simply consume these adapters, knowing exactly what properties and signals are available for binding, regardless of the underlying UI components being used.

#### `createXState` (e.g., `createStringState`)

- This is the **pure, low-level function** for creating the adapter state.
- It does **not** use Angular's Dependency Injection.
- It requires you to manually provide the fully configured options, including the final `validator` function itself (e.g., `validator: () => validators.string.minLength(5)`). You are responsible for accessing validators and constructing the validation logic.
- **Use Case:** Useful when Dependency Injection is not readily available (e.g., outside of Angular's injection context) or when you need absolute control over validator creation and configuration.

```typescript
template: `
  <mm-string-field [state]="state" />
`;
export class DemoComponent {
  state = createStringState('hello world!', {
    label: () => 'Greeting',
  });
}
```

#### `injectCreateXState` (e.g., `injectCreateStringState`)

- This function **utilizes Angular's Dependency Injection** (specifically `injectValidators`).
- It offers a more **convenient, higher-level API** for creating state _with integrated validation_.
- Instead of a raw `validator` function, it accepts a `validation` option which is typically a function returning a configuration object specific to the validator type (e.g., `validation: () => ({ required: true, minLength: 5 })` which uses `StringValidatorOptions`).
- It automatically uses the injected `validators` service (e.g., calling `validators.string.all(...)` internally) based on the `validation` options provided.
- It also typically handles deriving the `required` flag automatically from the `validation` options.
- **Use Case:** This is generally the **recommended approach** when working within an Angular application that uses the `@mmstack/form-validation` library. It mirrors our internal usage, reduces boilerplate, and simplifies integrating standard validation rules.

```typescript
function injectDemoState() {
  const stringFactory = injectCreateStringState();

  return stringFactory('hello world!', {
    label: () => 'Greeting',
    validation: () => ({
      required: true,
      minLength: 255,
      //...other string validator options
    }),
  });
}

template: `
  <mm-string-field [state]="state" />
`;
export class DemoComponent {
  state = injectDemoState();
}
```

### Adapters

Here's a summary of the core form state adapters provided by `@mmstack/form-adapters`:

| Adapter Type              | State Type                        | Value Type           | Key UI Properties/Signals                                                                  | Creation Functions                                         |
| :------------------------ | :-------------------------------- | :------------------- | :----------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| **Boolean**               | `BooleanState`                    | `boolean`            | `labelPosition`                                                                            | `createBooleanState`, `injectCreateBooleanState`           |
| **Toggle** (Boolean)      | `ToggleState`                     | `boolean`            | `labelPosition` (inherits from Boolean)                                                    | `createToggleState`, `injectCreateToggleState`             |
| **Date**                  | `DateState<TDate = Date>`         | `TDate \| null`      | `min`, `max`, `placeholder`                                                                | `createDateState`, `injectCreateDateState`                 |
| **Time**                  | `TimeState<TDate = Date>`         | `TDate \| null`      | `min`, `max`, `placeholder`, `interval`, `options`                                         | `createTimeState`, `injectCreateTimeState`                 |
| **DateTime**              | `DateTimeState<TDate = Date>`     | `TDate \| null`      | `min`, `max`, `placeholder`, `timeControl`, `dateControl`                                  | `createDateTimeState`, `injectCreateDateTimeState`         |
| **Date Range**            | `DateRangeState<TDate = Date>`    | `DateRange<TDate>`   | `min`, `max`, `placeholder`, `children`                                                    | `createDateRangeState`, `injectCreateDateRangeState`       |
| **Number**                | `NumberState`                     | `number \| null`     | `placeholder`, `step`                                                                      | `createNumberState`, `injectCreateNumberState`             |
| **String**                | `StringState`                     | `string \| null`     | `placeholder`, `autocomplete` (HTML attr)                                                  | `createStringState`, `injectCreateStringState`             |
| **Autocomplete** (String) | `AutocompleteState`               | `string \| null`     | `placeholder`, `options`, `panelWidth`, `displayWith`                                      | `createAutocompleteState`, `injectCreateAutocompleteState` |
| **Textarea** (String)     | `TextareaState`                   | `string \| null`     | `placeholder`, `rows`, `minRows`, `maxRows`, `autosize`                                    | `createTextareaState`, `injectCreateTextareaState`         |
| **Select** (Single)       | `SelectState<T>`                  | `T`                  | `placeholder`, `options`, `valueLabel`, `identify`, `display`, `equal`                     | `createSelectState`, `injectCreateSelectState`             |
| **Multi-Select**          | `MultiSelectState<T extends any>` | `T` (e.g., `string`) | `placeholder`, `options`, `identify`, `display`, `equal` (for items)                       | `createMultiSelectState`, `injectCreateMultiSelectState`   |
| **Button Group** (Select) | `ButtonGroupState<T>`             | `T`                  | `options`, `identify`, `display`, `equal`, `hideSingleSelectionIndicator`, `vertical`      | `createButtonGroupState`, `injectCreateButtonGroupState`   |
| **Search** (Async Select) | `SearchState<T>`                  | `T`                  | `placeholder`, `searchPlaceholder`, `query`, `request`, `identify`, `displayWith`, `equal` | `createSearchState`, `injectCreateSearchState`             |

## Simple example

```typescript
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { createStringState, StringFieldComponent } from '@mmstack/form-material';

@Component({
  selector: 'app-input-demo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StringFieldComponent],
  template: ` <mm-string-field [state]="state" /> `,
  styles: ``,
})
export class FormComponent {
  protected readonly state = createStringState('hello world!', {
    label: () => 'Greeting',
    required: () => true,
    validator: () => (value) => (value === 'hello world!' ? '' : 'Must be "hello world!"'),
  });
}
```

## Build your own form sub-components easily with formGroup & adapter primitives

No body likes 1 giant form component :) `@mmstack/form-material` & related libraries are made to create re-usable & nicely divided from state logic & components

```typescript
import { ChangeDetectionStrategy, Component, input, isSignal, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { derived, DerivedSignal, formGroup, FormGroupSignal, injectCreateStringState, injectCreateTextareaState, StringFieldComponent, StringState, TextareaFieldComponent, TextareaState } from '@mmstack/form-material';

export type Note = {
  title: string;
  body: string;
};

type NoteState<TParent = undefined> = FormGroupSignal<
  Note,
  {
    title: StringState<Note>;
    body: TextareaState<Note>;
  },
  TParent
>;

export function injectCreateNoteState() {
  const stringFactory = injectCreateStringState();
  const textareaFactory = injectCreateTextareaState();
  return <TParent = undefined>(value: Note | DerivedSignal<TParent, Note>): NoteState<TParent> => {
    const valueSignal = isSignal(value) ? value : signal(value);

    const title = stringFactory(derived(valueSignal, 'title'), {
      label: () => 'Subject',
      validation: () => ({
        required: true,
        trimmed: true,
        maxLength: 100,
      }),
    });

    return formGroup(valueSignal, {
      title,
      body: textareaFactory(derived(valueSignal, 'body'), {
        label: () => 'Note',
        // The validation options function re-runs when dependencies like title.value() change,
        // ensuring validators like 'not' use the latest values.
        validation: () => ({
          required: true,
          trimmed: true,
          maxLength: 1000,
          not: title.value(), // cant be the same as title
        }),
      }),
    });
  };
}

@Component({
  selector: 'app-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, StringFieldComponent, TextareaFieldComponent],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>{{ state().value().title }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <mm-string-field [state]="state().children().title" />
        <mm-textarea-field [state]="state().children().body" />
      </mat-card-content>
    </mat-card>
  `,
  styles: ``,
})
export class NoteComponent<TParent = undefined> {
  readonly state = input.required<NoteState<TParent>>();
}
```

## Available components

Here's a simple table show casing all components. They are 1-1 matched with the state adapters.

| Component Selector        | Required State Input (`[state]`) | Core Material UI Element(s)                 | Description                                                                               |
| :------------------------ | :------------------------------- | :------------------------------------------ | :---------------------------------------------------------------------------------------- |
| `<mm-string-field>`       | `StringState`                    | `matInput`                                  | Standard text input field.                                                                |
| `<mm-textarea-field>`     | `TextareaState`                  | `textarea[matInput]`, `cdkTextareaAutosize` | Text area input field, supports auto-sizing.                                              |
| `<mm-number-field>`       | `NumberState`                    | `input[type=number][matInput]`              | Input field specifically for numeric values.                                              |
| `<mm-boolean-field>`      | `BooleanState`                   | `matCheckbox`                               | Checkbox for boolean values. (Uses custom layout for hint/error).                         |
| `<mm-toggle>`             | `ToggleState`                    | `MatSlideToggle`                            | Toggle switch for boolean values. (Uses custom layout for hint/error).                    |
| `<mm-date-field>`         | `DateState`                      | `matInput`, `matDatepicker`                 | Input field with a date picker integration.                                               |
| `<mm-date-range-field>`   | `DateRangeState`                 | `matInput`, `matDateRangePicker`            | Input fields with a date-range picker integration                                         |
| `<mm-select-field>`       | `SelectState<T>`                 | `matSelect`, `matOption`                    | Dropdown select for choosing a single option from a static list.                          |
| `<mm-multi-select-field>` | `MultiSelectState<T>`            | `matSelect[multiple]`, `matOption`          | Dropdown select for choosing multiple options from a static list.                         |
| `<mm-button-group>`       | `ButtonGroupState<T>`            | `MatButtonToggleGroup`, `MatButtonToggle`   | Group of toggle buttons for selecting a single option from a static list.                 |
| `<mm-autocomplete-field>` | `AutocompleteState`              | `matInput`, `matAutocomplete`, `matOption`  | Text input with typeahead suggestions based on a static list of options.                  |
| `<mm-search-field>`       | `SearchState<T>`                 | `matSelect`, `matOption`, `matInput`        | Dropdown select populated via an asynchronous request, with built-in search/filter input. |
