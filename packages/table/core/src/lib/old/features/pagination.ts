import {
  computed,
  isSignal,
  signal,
  untracked,
  WritableSignal,
  type Signal,
} from '@angular/core';
import { createSelectState, type SelectState } from '@mmstack/form-adapters';
import { derived } from '@mmstack/primitives';

export type PaginationFeature = {
  page: Signal<number>;
  pageSize: SelectState<number, PaginationState>;
  next: () => void;
  previous: () => void;
  first: () => void;
  last: () => void;
  canNext: Signal<boolean>;
  canPrevious: Signal<boolean>;
  fromTo: Signal<string>;
  showFirstLast: Signal<boolean>;
  perPage: Signal<string>;
  setTotalSource: (total: Signal<number>) => void;
};

function defaultCreateTotalMessage(
  start: number,
  end: number,
  total: number,
): string {
  return `${start} - ${end} of ${total}`;
}

export type PaginationState = {
  page: number;
  pageSize: number;
};

export type PaginationOptions = {
  pageSizeOptions?: number[];
  perPageLabel?: () => string;
  total: () => number;
  createTotalMessage?: (start: number, end: number, total: number) => string;
  showFirstLast?: () => boolean;
};

export function mergePaginationState(
  state?: Partial<PaginationState>,
): PaginationState {
  return {
    page: 0,
    pageSize: 10,
    ...state,
  };
}

export function createPaginationFeature(
  pagination: WritableSignal<PaginationState>,
  opt: PaginationOptions,
): PaginationFeature {
  const page = derived(pagination, 'page');
  const pageSize = createSelectState(derived(pagination, 'pageSize', {}), {
    options: () => opt?.pageSizeOptions ?? [10, 25, 50],
    readonly: () => (opt?.pageSizeOptions?.length ?? 0) === 1,
  });

  const perPageFn = opt.perPageLabel ?? (() => 'Items per page:');

  const currentLast = computed(() => (page() + 1) * pageSize.value());

  const totalSrc = signal(
    isSignal(opt.total) ? opt.total : computed(opt.total),
  );
  const total = computed(() => totalSrc()());
  const canNext = computed(() => currentLast() < total());
  const canPrevious = computed(() => page() > 0);

  const createFromTo = opt.createTotalMessage ?? defaultCreateTotalMessage;

  return {
    page,
    pageSize,
    next: () => {
      if (!untracked(canNext)) return;
      page.update((s) => s + 1);
    },
    previous: () => {
      if (!untracked(canPrevious)) return;
      page.update((s) => s - 1);
    },
    first: () => {
      if (!untracked(canPrevious)) return;
      page.set(0);
    },
    last: () => {
      if (!untracked(canNext)) return;
      page.set(Math.ceil(untracked(total) / untracked(pageSize.value)) - 1);
    },
    canNext,
    canPrevious,
    fromTo: computed(() =>
      createFromTo(page() * pageSize.value() + 1, currentLast(), total()),
    ),
    showFirstLast: computed(() => opt.showFirstLast?.() ?? true),
    perPage: computed(perPageFn),
    setTotalSource: (totalSrcFn) => {
      totalSrc.set(totalSrcFn);
    },
  };
}
