import { computed, Signal, untracked, WritableSignal } from '@angular/core';
import { createSelectState, SelectState } from '@mmstack/form-adapters';
import { derived } from '@mmstack/primitives';
import { DeepPartial } from '../util';

export type PaginationOptions = {
  pagination?: {
    pageSizeOptions?: number[] | (() => number[]);
    totalCount?: number | (() => number);
    fromToLabel?: (
      total: number,
      pageIndex: number,
      pageSize: number,
    ) => string;
    pageSizeLabel?: () => string;
    showFirstLastButtons?: boolean | (() => boolean);
    disable?: boolean | (() => boolean);
  };
};

export type PaginationState = {
  pagination: {
    pageIndex: number;
    pageSize: number;
  };
};

export type PaginationFeature = {
  pagination: {
    total: Signal<number>;
    fromToLabel: Signal<string>;
    pageIndex: WritableSignal<number>;
    pageSize: WritableSignal<number>;
    pageSizeControl: SelectState<number, PaginationState['pagination']>;
    next: () => void;
    prev: () => void;
    first: () => void;
    last: () => void;
    showFirstLast: Signal<boolean>;
    nextDisabled: Signal<boolean>;
    prevDisabled: Signal<boolean>;
    enabled: Signal<boolean>;
  };
};

function defaultFromToLabel(
  total: number,
  pageIndex: number,
  pageSize: number,
): string {
  const from = pageIndex * pageSize + 1;
  const to = Math.min((pageIndex + 1) * pageSize, total);
  return `${from} - ${to} of ${total}`;
}

export function createPaginationState(
  initial: DeepPartial<PaginationState> = {},
): PaginationState {
  return {
    pagination: {
      pageIndex: initial.pagination?.pageIndex ?? 0,
      pageSize: initial.pagination?.pageSize ?? 10,
    },
  };
}
export function createPagination(
  state: WritableSignal<PaginationState>,
  opt: PaginationOptions & {
    resolvedTotalCount: Signal<number>;
  },
): PaginationFeature {
  const pageSizeOptionsOpt = opt.pagination?.pageSizeOptions ?? [10, 25, 50];

  const pageSizeOptions = Array.isArray(pageSizeOptionsOpt)
    ? computed(() => pageSizeOptionsOpt)
    : computed(pageSizeOptionsOpt);

  const pagination = derived(state, 'pagination');

  const pageIndex = derived(pagination, 'pageIndex');
  const pageSize = derived(pagination, 'pageSize');

  const disabledOpt = opt.pagination?.disable ?? false;
  const disabled =
    typeof disabledOpt === 'boolean'
      ? computed(() => disabledOpt)
      : computed(disabledOpt);

  const pageSizeCtrl = createSelectState(pageSize, {
    label: () => opt.pagination?.pageSizeLabel?.() ?? 'Page Size',
    options: pageSizeOptions,
    readonly: () => pageSizeOptions().length <= 1,
    disable: disabled,
  });

  const total = opt.resolvedTotalCount;
  const totalLabelFn = opt.pagination?.fromToLabel ?? defaultFromToLabel;
  const fromToLabel = computed(() =>
    totalLabelFn(total(), pageIndex(), pageSize()),
  );

  const showFirstLastOpt = opt.pagination?.showFirstLastButtons ?? true;
  const showFirstLast =
    typeof showFirstLastOpt === 'boolean'
      ? computed(() => showFirstLastOpt)
      : computed(showFirstLastOpt);

  const totalPages = computed(() => Math.ceil(total() / pageSize()) - 1);

  const prevDisabled = computed(() => disabled() || pageIndex() <= 0);

  const nextDisabled = computed(
    () => disabled() || pageIndex() >= totalPages(),
  );

  return {
    pagination: {
      total,
      fromToLabel,
      pageIndex,
      pageSize,
      pageSizeControl: pageSizeCtrl,
      showFirstLast,
      next: () => {
        if (untracked(nextDisabled)) return;
        pageIndex.update((idx) => idx + 1);
      },
      last: () => {
        if (untracked(nextDisabled)) return;
        pageIndex.set(untracked(totalPages));
      },
      prev: () => {
        if (untracked(prevDisabled)) return;
        pageIndex.update((idx) => Math.max(idx - 1, 0));
      },
      first: () => {
        if (untracked(prevDisabled)) return;
        pageIndex.set(0);
      },
      nextDisabled,
      prevDisabled,
      enabled: computed(() => !disabled()),
    },
  };
}
