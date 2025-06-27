import { computed, isSignal, Signal, untracked } from '@angular/core';
import { ColumnDef } from './column';
import { SortDirection } from './features';
import { TableFeatures } from './table';

type BaseCell<U, TColumnName extends string> = {
  name: TColumnName;
  value: Signal<U>;
};

export type Cell<U, TColumnName extends string> = BaseCell<U, TColumnName>

export type FooterCell<TColumnName extends string> = BaseCell<string, TColumnName>;

type VoidFunctionWithDisabled = (() => void) & {
  disabled: Signal<boolean>;
};

export type HeaderCell<TColumnName extends string> = BaseCell<string, TColumnName> & {
  features: {
    sort: {
      direction: Signal<SortDirection | null>;
      toggleSort: () => void;
      sort: (dir: SortDirection) => void;
      clear: () => void;
    };
    hide: () => void;
    columnOrder: {
      left: VoidFunctionWithDisabled;
      right: VoidFunctionWithDisabled;
      first: VoidFunctionWithDisabled;
      last: VoidFunctionWithDisabled;
    };
  };
};



export function createCell<T, U, TColumnName extends string>(
  source: Signal<T>,
  def: ColumnDef<T, U, TColumnName>,
  features: Omit<TableFeatures<T, TColumnName>, 'pagination'>,
): Cell<U, TColumnName> {
  const value = computed(() => def.accessor(source()), def);
  const isHidden = computed(
    () => features.columnVisibility.state()[def.name] === false,
  );

  return {
    name: def.name,
    value,
  };
}

const UP_ARROW = '▲';
const DOWN_ARROW = '▼';

function createVoidFunctionWithDisabled(
  fn: () => void,
  disable: () => boolean,
): VoidFunctionWithDisabled {
  const internal = fn as VoidFunctionWithDisabled;
  internal.disabled = isSignal(disable) ? disable :  computed(disable);
  return internal;
}

export function createHeaderCell<T, U, TColumnName extends string>(
  def: ColumnDef<T, U, TColumnName>,
  features: Omit<TableFeatures<T, TColumnName>, 'pagination'>,
): HeaderCell<TColumnName> {
  const currentIndex = computed(() =>
    features.columnOrder.state().indexOf(def.name),
  );

  const baseValue = computed(() => def.header?.() ?? '');

  const direction = computed(() => {
    const sort = features.sort.state();
    if (sort?.name !== def.name) return null;
    return sort.direction;
  });

  const directionSuffix = computed(() => {
    switch (direction()) {
      case 'asc':
        return UP_ARROW;
      case 'desc':
        return DOWN_ARROW;
      default:
        return '';
    }
  });

  const disableMoveLeft = computed(() =>  currentIndex() <= 0);


  const lastIndex = computed(() => features.columnOrder.state().length - 1);

  const disableMoveRight = computed(() => currentIndex() >= lastIndex())

  return {
    name: def.name,
    value: computed(() => `${baseValue()}${directionSuffix()}`),
    features: {
      sort: {
        direction,
        toggleSort: () => features.sort.toggleSort(def.name),
        sort: (dir: SortDirection) => features.sort.sort(def.name, dir),
        clear: () => features.sort.clearSort(),
      },
      hide: () => features.columnVisibility.set(def.name, false),
      columnOrder: {
        left: createVoidFunctionWithDisabled(
          () => {
            const ci = untracked(currentIndex);
            if (untracked(disableMoveLeft)) return;
            features.columnOrder.set(def.name, ci - 1);
          },
          disableMoveLeft,
        ),
        right: createVoidFunctionWithDisabled(
          () => {
            const ci = untracked(currentIndex);
            if (untracked(disableMoveRight)) return;
            features.columnOrder.set(def.name, ci + 1);
          },
          disableMoveRight
        ),
        first: createVoidFunctionWithDisabled(
          () => {
            if (untracked(disableMoveLeft)) return;
            features.columnOrder.set(def.name, 0);
          },
          disableMoveLeft
        ),
        last: createVoidFunctionWithDisabled(
          () => {
            if (untracked(disableMoveRight)) return;
            features.columnOrder.set(def.name, untracked(lastIndex));
          },
          disableMoveRight
        )
      },
    },
  };
}

export function createFooterCell<T, U, TColumnName extends string>(def: ColumnDef<T, U, TColumnName>): FooterCell<TColumnName> {
  return {
    name: def.name,
    value: computed(() => def.footer?.() ?? ''),
  };
}
