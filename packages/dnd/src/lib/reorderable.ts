import {
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  type Signal,
  type WritableSignal,
} from '@angular/core';

import { draggable } from './draggable';
import { DropIndicator } from './drop-indicator';
import { dropTarget } from './drop-target';
import type { DragMeta, Edge } from './types';

export const REORDERABLE_ID_KEY = Symbol('@mmstack/dnd:reorderable-id');
export const REORDERABLE_GROUP_KEY = Symbol('@mmstack/dnd:reorderable-group');

export type ReorderableMeta = {
  readonly id: symbol;
  readonly group: string | undefined;
};

export type ReorderEvent<T> = { item: T; from: number; to: number };
export type ItemArrivedEvent<T> = { item: T; to: number };
export type ItemLeftEvent<T> = { item: T; from: number };

export type ReorderableOptions<T> = {
  accepts: (d: unknown) => d is T;
  key: (item: T) => string | number;
  /**
   * When two reorderables share the same `group` string they can exchange
   * items via cross-list drag-and-drop. Omitting this value restricts the
   * reorderable to within-list reordering only.
   */
  group?: string;
  /** Defaults to `['top', 'bottom']`. */
  edges?: Edge[];
  /** Render the default drop indicator on each item. Defaults to `true`. */
  indicated?: boolean;
  onReorder?: (event: ReorderEvent<T>) => void;
  onItemArrived?: (event: ItemArrivedEvent<T>) => void;
  onItemLeft?: (event: ItemLeftEvent<T>) => void;
};

export type ReorderableRef<T> = {
  items: Signal<readonly T[]>;
  key: (item: T) => string | number;
  readonly _meta: ReorderableMeta;
  readonly _opts: ReorderableOptions<T>;
  readonly _items: WritableSignal<T[]>;
};

type SlotData = {
  reorderableId: symbol;
  group: string | undefined;
  index: number;
};

function isSlotData(d: unknown): d is SlotData {
  return (
    !!d &&
    typeof d === 'object' &&
    'reorderableId' in d &&
    typeof (d as SlotData).index === 'number'
  );
}

function readSourceMeta(
  meta: DragMeta,
): { id: symbol; group: string | undefined } | null {
  const id = meta[REORDERABLE_ID_KEY] as symbol | undefined;
  if (!id) return null;
  const group = meta[REORDERABLE_GROUP_KEY] as string | undefined;
  return { id, group };
}

function acceptsFromGroup(meta: DragMeta, target: ReorderableMeta): boolean {
  const sourceId = meta[REORDERABLE_ID_KEY] as symbol | undefined;
  if (!sourceId) return false;
  if (sourceId === target.id) return true;
  if (!target.group) return false;
  const sourceGroup = meta[REORDERABLE_GROUP_KEY] as string | undefined;
  return sourceGroup === target.group;
}

function computeInsertIndex(targetIndex: number, edge: Edge | null): number {
  return targetIndex + (edge === 'bottom' || edge === 'right' ? 1 : 0);
}

function handleSameListReorder<T>(
  ref: ReorderableRef<T>,
  item: T,
  rawTo: number,
): void {
  const arr = ref._items();
  const k = ref.key(item);
  const from = arr.findIndex((i) => ref.key(i) === k);
  if (from === -1) return;
  let to = rawTo;
  if (from < to) to -= 1;
  if (from === to) return;
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  ref._items.set(next);
  ref._opts.onReorder?.({ item, from, to });
}

function handleCrossListArrival<T>(
  ref: ReorderableRef<T>,
  item: T,
  to: number,
): void {
  const next = ref._items().slice();
  const clamped = Math.min(Math.max(to, 0), next.length);
  next.splice(clamped, 0, item);
  ref._items.set(next);
  ref._opts.onItemArrived?.({ item, to: clamped });
}

export function reorderable<T>(
  items: WritableSignal<T[]>,
  opts: ReorderableOptions<T>,
): ReorderableRef<T> {
  const id = Symbol(`@mmstack/dnd:reorderable[${opts.group ?? 'anon'}]`);
  return {
    items: items.asReadonly(),
    key: opts.key,
    _meta: { id, group: opts.group },
    _opts: opts,
    _items: items,
  };
}

@Directive({
  selector: '[mmReorderable]',
  exportAs: 'mmReorderable',
})
export class Reorderable<T = unknown> {
  readonly ref = input.required<ReorderableRef<T>>({ alias: 'mmReorderable' });

  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;

  constructor() {
    const getRef = () => this.ref();
    const host = this.host;

    dropTarget<T, SlotData>({
      accepts: (d): d is T => getRef()._opts.accepts(d),
      data: () => ({
        reorderableId: getRef()._meta.id,
        group: getRef()._meta.group,
        index: getRef()._items().length,
      }),
      canDrop: ({ source: { meta } }) =>
        acceptsFromGroup(meta, getRef()._meta),
      onDrop: ({ data, meta, location }) => {
        // Only act when WE are the innermost drop target — otherwise a child
        // item's drop target already handled this drop.
        if (location.current[0]?.element !== host) return;
        const sourceMeta = readSourceMeta(meta);
        if (!sourceMeta) return;
        const r = getRef();
        if (sourceMeta.id === r._meta.id) {
          handleSameListReorder(r, data, r._items().length);
        } else {
          handleCrossListArrival(r, data, r._items().length);
        }
      },
    });
  }
}

@Directive({
  selector: '[mmReorderableItem]',
  exportAs: 'mmReorderableItem',
  hostDirectives: [DropIndicator],
})
export class ReorderableItem<T = unknown> {
  readonly item = input.required<T>({ alias: 'mmReorderableItem' });

  private readonly parent = inject<Reorderable<T>>(Reorderable);
  private readonly indicator = inject(DropIndicator);

  readonly index = computed(() => {
    const r = this.parent.ref();
    const k = r.key(this.item());
    return r._items().findIndex((i) => r.key(i) === k);
  });

  constructor() {
    const getRef = () => this.parent.ref();

    draggable<T, DragMeta>({
      data: this.item,
      meta: () => ({
        [REORDERABLE_ID_KEY]: getRef()._meta.id,
        [REORDERABLE_GROUP_KEY]: getRef()._meta.group,
      }),
      onDrop: ({ data, location }) => {
        const target = location.current[0]?.data;
        if (!isSlotData(target)) return;
        const r = getRef();
        if (target.reorderableId === r._meta.id) return; // same-list, target handled it
        const k = r.key(data);
        const from = r._items().findIndex((i) => r.key(i) === k);
        if (from === -1) return;
        r._items.update((arr) => arr.filter((i) => r.key(i) !== k));
        r._opts.onItemLeft?.({ item: data, from });
      },
    });

    const dropRef = dropTarget<T, SlotData>({
      accepts: (d): d is T => getRef()._opts.accepts(d),
      data: () => ({
        reorderableId: getRef()._meta.id,
        group: getRef()._meta.group,
        index: this.index(),
      }),
      canDrop: ({ source: { meta } }) =>
        acceptsFromGroup(meta, getRef()._meta),
      edges: () => getRef()._opts.edges ?? ['top', 'bottom'],
      onDrop: ({ data, meta, edge }) => {
        const sourceMeta = readSourceMeta(meta);
        if (!sourceMeta) return;
        const r = getRef();
        const insertAt = computeInsertIndex(this.index(), edge);
        if (sourceMeta.id === r._meta.id) {
          handleSameListReorder(r, data, insertAt);
        } else {
          handleCrossListArrival(r, data, insertAt);
        }
      },
    });

    effect(() => this.indicator.edge.set(dropRef.closestEdge()));
    effect(() => {
      const indicated = getRef()._opts.indicated ?? true;
      this.indicator.disabled.set(!indicated);
    });
  }
}
