import {
  computed,
  linkedSignal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { derived, type DerivedSignal } from '@mmstack/primitives';
import {
  formControl,
  type CreateFormControlOptions,
  type FormControlSignal,
} from './form-control';
import { type SignalValue } from './signal-value.type';
import { mergeArray } from './util';

export type FormArraySignal<
  T,
  TIndividualState extends FormControlSignal<
    T,
    any,
    any,
    any
  > = FormControlSignal<T, any, any, any>,
  TParent = undefined,
> = FormControlSignal<
  T[],
  TParent,
  'array',
  | Exclude<SignalValue<TIndividualState['partialValue']>, null | undefined>[]
  | undefined
> & {
  ownError: Signal<string>;
  children: Signal<TIndividualState[]>;
  push: (value: T) => void; // add new control with value
  remove: (index: number) => void; // remove at index
  min: Signal<number>; // for display purposes
  max: Signal<number>; // for display purposes
  canAdd: Signal<boolean>; // disable add button if false
  canRemove: Signal<boolean>; // disable remove buttons if false
};

export type CreateFormArraySignalOptions<
  T,
  TIndividualState extends FormControlSignal<T, any, any, any>,
> = Omit<CreateFormControlOptions<T[]>, 'equal'> & {
  min?: () => number;
  max?: () => number;
  equal?: (a: T, b: T) => boolean;
  toPartialValue?: (
    v: T,
  ) => Exclude<SignalValue<TIndividualState['partialValue']>, null | undefined>;
};

function createReconcileChildren<
  T,
  TIndividualState extends FormControlSignal<T, any, any, any>,
>(
  factory: (val: DerivedSignal<T[], T>, idx: number) => TIndividualState,
  opt: { equal: (a: T, b: T) => boolean },
) {
  return (
    length: number,
    source: WritableSignal<T[]>,
    prev?: TIndividualState[],
  ): TIndividualState[] => {
    if (!prev) {
      const nextControls = [];

      for (let i = 0; i < length; i++) {
        nextControls.push(
          factory(derived(source, i, { equal: opt?.equal }), i),
        );
      }

      return nextControls;
    }

    if (length === prev.length) return prev;

    const next = [...prev];

    if (length < prev.length) {
      next.splice(length);
    } else if (length > prev.length) {
      for (let i = prev.length; i < length; i++) {
        next.push(factory(derived(source, i, { equal: opt?.equal }), i));
      }
    }

    return next;
  };
}

export function formArray<
  T,
  TIndividualState extends FormControlSignal<
    T,
    any,
    any,
    any
  > = FormControlSignal<T, any, any, any>,
  TParent = undefined,
>(
  initial: T[] | DerivedSignal<TParent, T[]>,
  factory: (val: DerivedSignal<T[], T>, idx: number) => TIndividualState,
  opt?: CreateFormArraySignalOptions<T, TIndividualState>,
): FormArraySignal<T, TIndividualState, TParent> {
  const eq = opt?.equal ?? Object.is;

  const arrayEqual = (a: T[], b: T[]) => {
    if (a.length !== b.length) return false;
    if (!a.length) return true;

    return a.every((v, i) => eq(v, b[i]));
  };

  const min = computed(() => opt?.min?.() ?? 0);
  const max = computed(() => opt?.max?.() ?? Number.MAX_SAFE_INTEGER);

  const arrayOptions: CreateFormControlOptions<T[], 'array'> = {
    ...opt,
    equal: arrayEqual,
    dirtyEquality: (a, b) => a.length === b.length,
    controlType: 'array',
  };

  const ctrl = formControl<T[], TParent, 'array'>(
    initial,
    arrayOptions,
  ) satisfies FormControlSignal<T[], TParent, 'array'>;

  const length = computed(() => ctrl.value().length);

  const reconcileChildren = createReconcileChildren<T, TIndividualState>(
    factory,
    { equal: eq },
  );

  // linkedSignal used to re-use previous value so that only length changes are affected and existing controls are kept, but updated
  const children = linkedSignal<number, TIndividualState[]>({
    source: () => length(),
    computation: (len, prev) => reconcileChildren(len, ctrl.value, prev?.value),
  });

  const ownError = computed(() => ctrl.error());

  const error = computed((): string => {
    const own = ownError();
    if (own) return own;
    if (!children().length) return '';
    return children()
      .map((c, idx) => (c.error() ? `${idx}: ${c.error()}` : ''))
      .filter(Boolean)
      .join('\n');
  });

  const dirty = computed(() => {
    if (ctrl.dirty()) return true;
    if (!children().length) return false;
    return children().some((c) => c.dirty());
  });

  const markAllAsTouched = () => {
    ctrl.markAllAsTouched();
    for (const c of untracked(children)) {
      c.markAllAsTouched();
    }
  };
  const markAllAsPristine = () => {
    ctrl.markAllAsPristine();
    for (const c of untracked(children)) {
      c.markAllAsPristine();
    }
  };

  const toPartialValue = opt?.toPartialValue ?? ((v: T) => v);
  const partialValue = computed(() => {
    if (!dirty()) return undefined;
    return children().map((c) => {
      const pv = c.partialValue();
      if (pv) return pv;
      if (c.controlType === 'control') return undefined;

      // return full value for  child objects/arrays as this cannot be partially patched without idx
      return toPartialValue(c.value());
    });
  });

  const touched = computed(
    () =>
      ctrl.touched() ||
      !!(children().length && children().some((c) => c.touched())),
  );

  const reconcile = (newValue: T[]) => {
    const ctrls = untracked(children);

    for (let i = 0; i < newValue.length; i++) {
      ctrls.at(i)?.reconcile(newValue[i]); // reconcile existing controls that are relevant addition/removal will be handled after ctrl.reconcile through linkedSignal
    }

    ctrl.reconcile(mergeArray(newValue, untracked(ctrl.value)));
  };

  const forceReconcile = (newValue: T[]) => {
    const ctrls = untracked(children);

    for (let i = 0; i < newValue.length; i++) {
      ctrls.at(i)?.forceReconcile(newValue[i]);
    }

    ctrl.forceReconcile(newValue);
  };

  const childrenValid = computed(() => {
    if (!children().length) return true;
    return children().every((d) => d.valid());
  });

  const childrenPending = computed(
    () => !!children().length && children().some((d) => d.pending()),
  );

  return {
    ...ctrl,
    ownError,
    error,
    valid: computed(() => ctrl.valid() && childrenValid()),
    pending: computed(() => ctrl.pending() || childrenPending()),
    touched,
    children,
    dirty,
    markAllAsTouched,
    markAllAsPristine,
    min,
    max,
    partialValue,
    canAdd: computed(
      () => !ctrl.disabled() && !ctrl.readonly() && length() < max(),
    ),
    canRemove: computed(
      () => !ctrl.disabled() && !ctrl.readonly() && length() > min(),
    ),
    reconcile,
    forceReconcile,
    reset: () => {
      for (const c of untracked(children)) {
        c.reset();
      }
      ctrl.reset();
    },
    resetWithInitial: (initial: T[]) => {
      const ctrls = untracked(children);
      for (let i = 0; i < initial.length; i++) {
        ctrls.at(i)?.resetWithInitial(initial[i]);
      }
      ctrl.resetWithInitial(initial);
    },
    push: (next) => ctrl.value.update((cur) => [...cur, next]),
    remove: (idx) =>
      ctrl.value.update((cur) => cur.filter((_, i) => i !== idx)),
  };
}
