import {
  Component,
  ComponentRef,
  computed,
  input,
  inputBinding,
  Signal,
  untracked,
  ViewContainerRef,
  WritableSignal,
} from '@angular/core';
import { derived, mapArray } from '@mmstack/primitives';
import {
  ColumnOrderingFeature,
  ColumnOrderingOptions,
  ColumnOrderingState,
  ColumnVisibilityFeature,
  ColumnVisibilityOptions,
  ColumnVisibilityState,
} from './features';

/**
 * Defines the structure and behavior of a single column in the table.
 */
export type ColumnDef<T, C = any> = {
  /**
   * The unique name of the column.
   * This is used to identify the column in the table.
   */
  name: string;
  /**
   * The header label to be rendered.
   */
  header: string | (() => string);
  /**
   * Component to be rendered within the table-cell component
   */
  createComponent: (
    vc: ViewContainerRef,
    source: Signal<T>,
    idx: number,
  ) => ComponentRef<C>;
  /** The footer to be rendered
   */
  footer?: string | (() => string);
  /** The fixed with or min/max width of the column
   */
  size?:
    | number
    | { min?: number; max?: number }
    | (() => number | { min?: number; max?: number });
  disableSorting?: boolean | (() => boolean);
  /** Enables/disables filtering this column.
   * @default false
   */
  disableFiltering?: boolean | (() => boolean);
  /** Enables/disables resizing this column.
   * @default false
   */
  disableResizing?: boolean | (() => boolean);
  /** Enables/disables hiding this column.
   * @default false
   */
  disableHiding?: boolean | (() => boolean);
  /** Enables/disables pinning this column.
   * @default false
   */
  disablePinning?: boolean | (() => boolean);
};

type DefinedAccessorColumnBuilder<T, TResolved> = (
  fn: (source: T, index: number) => TResolved | undefined,
  opt: Omit<ColumnDef<T>, 'createComponent'> & {
    format?: (value: TResolved | undefined, index: number) => string;
  },
) => ColumnDef<T>;

type ColumnHelper<T> = {
  date: DefinedAccessorColumnBuilder<T, Date>;
  number: DefinedAccessorColumnBuilder<T, number>;
  string: DefinedAccessorColumnBuilder<T, string>;
  boolean: DefinedAccessorColumnBuilder<T, boolean>;
};

function defaultFormatter(value?: Date | number | string | boolean): string {
  if (value === undefined) return '';
  return value.toString();
}

@Component({
  selector: 'mm-cell-value',
  template: `{{ displayValue() }}`,
})
export class CellValueComponent {
  readonly displayValue = input(computed(() => ''));
}

export function createColumnHelper<T>(): ColumnHelper<T> {
  return {
    date: (v, opt) => {
      return {
        ...opt,
        createComponent: (vc, source, idx) => {
          const value = computed(() => v(source(), idx), {
            equal: (a, b) => a?.getTime() === b?.getTime(),
          });

          const formatter = opt.format ?? defaultFormatter;

          const formattedValue = computed(() => formatter(value(), idx));

          return vc.createComponent(CellValueComponent, {
            bindings: [inputBinding('displayValue', () => formattedValue)],
          });
        },
      };
    },
    number: (v, opt) => {
      return {
        ...opt,
        createComponent: (vc, source, idx) => {
          const value = computed(() => v(source(), idx), {
            equal: (a, b) => a === b,
          });

          const formatter = opt.format ?? defaultFormatter;

          const formattedValue = computed(() => formatter(value(), idx));

          return vc.createComponent(CellValueComponent, {
            bindings: [inputBinding('displayValue', () => formattedValue)],
          });
        },
      };
    },
    string: (v, opt) => {
      return {
        ...opt,
        createComponent: (vc, source, idx) => {
          const value = computed(() => v(source(), idx), {
            equal: (a, b) => a === b,
          });

          const formatter = opt.format ?? defaultFormatter;

          const formattedValue = computed(() => formatter(value(), idx));

          return vc.createComponent(CellValueComponent, {
            bindings: [inputBinding('displayValue', () => formattedValue)],
          });
        },
      };
    },
    boolean: (v, opt) => {
      return {
        ...opt,
        createComponent: (vc, source, idx) => {
          const value = computed(() => v(source(), idx), {
            equal: (a, b) => a === b,
          });

          const formatter = opt.format ?? defaultFormatter;

          const formattedValue = computed(() => formatter(value(), idx));

          return vc.createComponent(CellValueComponent, {
            bindings: [inputBinding('displayValue', () => formattedValue)],
          });
        },
      };
    },
  };
}

export type Column<T, C = any> = {
  name: string;
  def: ColumnDef<T, C>;
  header: Signal<string>;
  footer: Signal<string | null>;
  size: Signal<{ min: number; max: number } | null>;

  features: ColumnVisibilityFeature & ColumnOrderingFeature;
  // disableSorting: Signal<boolean>;
  // disableFiltering: Signal<boolean>;
  // disableResizing: Signal<boolean>;
  // disablePinning: Signal<boolean>;
};

type CreateColumnState = ColumnVisibilityState & ColumnOrderingState;

type CreateColumnOptions = ColumnVisibilityOptions & ColumnOrderingOptions;

function signalifySize(size: ColumnDef<any>['size']): Column<any>['size'] {
  if (size === undefined) return computed(() => null);
  if (typeof size === 'number') {
    return computed(() => ({ min: size, max: size }));
  }
  if (typeof size === 'function') {
    return computed(
      () => {
        const s = size();
        if (typeof s === 'number') return { min: s, max: s };
        return {
          min: 0,
          max: 10000,
          ...s,
        };
      },
      {
        equal: (a, b) => a.min === b.min && a.max === b.max,
      },
    );
  }
  return computed(() => {
    return {
      min: 0,
      max: 10000,
      ...size,
    };
  });
}

export function createColumns<T>(
  defs: ColumnDef<T>[],
  state: WritableSignal<CreateColumnState>,
  opt: CreateColumnOptions,
): Signal<Signal<Column<T>>[]> {
  const visibilityState = derived(state, 'columnVisibility');
  const orderingState = derived(state, 'columnOrdering');

  const visibilityDisabledOpt = opt.columnVisibility?.disable ?? false;
  const visibilityDisabled =
    typeof visibilityDisabledOpt === 'boolean'
      ? computed(() => visibilityDisabledOpt)
      : computed(visibilityDisabledOpt);

  const orderingDisabledOpt = opt.columnOrdering?.enabled ?? false;
  const orderingDisabled =
    typeof orderingDisabledOpt === 'boolean'
      ? computed(() => orderingDisabledOpt)
      : computed(orderingDisabledOpt);

  const columnMap = new Map(
    defs.map((def): [string, Column<T>] => {
      const { disableHiding = false, footer, header } = def;
      const disableHidingSig =
        typeof disableHiding === 'boolean'
          ? computed(() => disableHiding)
          : computed(disableHiding);

      const columnVisibilityDisabled = computed(
        () => visibilityDisabled() || disableHidingSig(),
      );

      const moveToStart = () => {
        if (untracked(orderingDisabled)) return;
        orderingState.update((cur) => [
          def.name,
          ...cur.filter((c) => c !== def.name),
        ]);
      };

      const moveToEnd = () => {
        if (untracked(orderingDisabled)) return;
        orderingState.update((cur) => [
          ...cur.filter((c) => c !== def.name),
          def.name,
        ]);
      };

      return [
        def.name,
        {
          def,
          name: def.name,
          header:
            typeof header === 'string'
              ? computed(() => header)
              : computed(header),
          footer:
            typeof footer === 'string' || footer === undefined
              ? computed(() => footer ?? null)
              : computed(footer),
          size: signalifySize(def.size),
          features: {
            columnVisibility: {
              disabled: columnVisibilityDisabled,
              visible: computed(() => {
                if (columnVisibilityDisabled()) return true;
                return visibilityState()[def.name] ?? true;
              }),
              toggle: () => {
                if (untracked(columnVisibilityDisabled)) return;
                visibilityState.update((cur) => ({
                  ...cur,
                  [def.name]: !cur[def.name],
                }));
              },
              show: () => {
                if (untracked(columnVisibilityDisabled)) return;
                visibilityState.update((cur) => ({
                  ...cur,
                  [def.name]: true,
                }));
              },
              hide: () => {
                if (untracked(columnVisibilityDisabled)) return;
                visibilityState.update((cur) => ({
                  ...cur,
                  [def.name]: false,
                }));
              },
            },
            columnOrdering: {
              moveTo: (idx) => {
                if (untracked(orderingDisabled)) return;
                if (idx === 0) return moveToStart();
                if (idx >= untracked(orderingState).length) return moveToEnd();

                return orderingState.update((cur) => {
                  const next = [...cur];
                  const currentIndex = next.indexOf(def.name);

                  if (currentIndex !== -1) next.splice(currentIndex, 1);
                  next.splice(idx, 0, def.name);
                  return next;
                });
              },
              moveToStart,
              moveToEnd,
            },
          },
        },
      ];
    }),
  );

  const initialOrderState = untracked(orderingState).filter((name) =>
    columnMap.has(name),
  );
  if (initialOrderState.length !== columnMap.size) {
    for (const def of defs) {
      if (!initialOrderState.includes(def.name))
        initialOrderState.push(def.name);
    }
  }

  return mapArray(orderingState, (name) =>
    computed(() => columnMap.get(name())!),
  );
}
