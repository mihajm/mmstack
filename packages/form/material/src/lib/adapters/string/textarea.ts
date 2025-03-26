import { computed, Signal } from '@angular/core';
import {
  createTextareaState as genericCreateTextareaState,
  injectCreateTextareaState as genericInjectCreateTextareaState,
  type TextareaState as GenericTextareaState,
  type TextareaStateOptions as GenericTextareaStateOptions,
} from '@mmstack/form-adapters';
import { StringValidatorOptions } from '@mmstack/form-validation';
import { DerivedSignal } from '@mmstack/primitives';

export type TextareaState<TParent = undefined> =
  GenericTextareaState<TParent> & {
    autosize: Signal<boolean>;
  };

export type TextareaStateOptions = GenericTextareaStateOptions & {
  autosize?: () => boolean;
};

function toMaterialSpecifics<TParent>(
  state: GenericTextareaState<TParent>,
  opt?: TextareaStateOptions,
): TextareaState<TParent> {
  return {
    ...state,
    autosize: computed(() => opt?.autosize?.() ?? true),
  };
}

export function createTextareaState<TParent = undefined>(
  value: string | null | DerivedSignal<TParent, string | null>,
  opt?: TextareaStateOptions,
): TextareaState<TParent> {
  return toMaterialSpecifics(genericCreateTextareaState(value, opt), opt);
}

export function injectCreateTextareaState() {
  const factory = genericInjectCreateTextareaState();

  return <TParent = undefined>(
    value: string | null | DerivedSignal<TParent, string | null>,
    opt?: Omit<TextareaStateOptions, 'required' | 'validator'> & {
      validation?: () => StringValidatorOptions;
    },
  ): TextareaState<TParent> => {
    return toMaterialSpecifics(factory(value, opt), opt);
  };
}
