import type { Injector, Signal } from '@angular/core';

import type { DragEngine } from '../session';
import type { Axis } from './geometry';
import type { DragGeometry } from './session';
import type { SortableGroup, SortableGroupMember } from './group';

/**
 * The during-drag reflow glide — how siblings ease as they move aside to open
 * the gap. NOT a drop animation: on drop the commit is instant. Non-overshoot on
 * purpose — an overshoot spring wobbles when the insert re-targets on a fast drag.
 */
export type ReorderableAnimation = {
  /** ms. @default 200 */
  duration?: number;
  /** CSS easing. @default decisive decelerate (no overshoot). */
  easing?: string;
};

/**
 * The reorder helpers handed to a custom keyboard handler ({@link
 * ReorderableOptions.onKeyboardKeydown}). `move` reuses the built-in commit +
 * a11y announce + focus-restore, so a custom handler only decides *when* to move.
 */
export type ReorderKeyboardApi<T> = {
  /** The focused item. */
  readonly item: T;
  /** Its current index in the list. */
  readonly index: number;
  /** The list length. */
  readonly total: number;
  /** The list main axis. */
  readonly axis: Axis;
  /** Whether the jump-to-start/end modifier is held (see {@link ReorderableOptions.jumpModifier}). */
  readonly jump: boolean;
  /**
   * Move the focused item to `to` (clamped to `[0, total-1]`): splices the source,
   * announces the move, and keeps focus on the item. A no-op if `to` is the current index.
   */
  move(to: number): void;
};

/** Reorderable options common to both engines. */
type ReorderableSharedOptions<T, K> = {
  /** Stable identity for an item — used for the key→index map and DOM registry. */
  readonly key: (item: T) => K;
  /**
   * Injector to resolve DI option defaults through (see `provideReorderableDefaults`).
   * `injectReorderable` supplies it automatically; the pure `reorderable` reads defaults
   * only when one is present.
   */
  readonly injector?: Injector;
  /** List main axis. @default 'y' */
  readonly axis?: Axis;
  /** Px a center must be cleared by before the insert index flips. @default 4 */
  readonly deadband?: number;
  /** During-drag reflow glide, or `false` for instant reflow. @default decisive 200ms */
  readonly animation?: ReorderableAnimation | false;
  /**
   * Opt-in edge auto-scroll while dragging (absent/`false` → off). `edge` is the max
   * engage band px, `speed` the max px/60fps-frame; `edgeProportion` sizes the band as
   * a fraction of the container (capped at `edge`) and `maxSpeedAt` is the fraction of
   * the band where full speed is reached (`edgeAutoScroll`-specific — ignored by
   * pragmatic's). Defaults `{ edge: 48, speed: 16, edgeProportion: 0.25, maxSpeedAt: 0.5 }`.
   * Requires an auto-scroll plugin: register `edgeAutoScroll` (zero-dependency) or
   * pragmatic's `autoScrollForElements` via {@link provideDnd} (or the composable
   * option). Without one, a dev warning fires and scrolling no-ops.
   */
  readonly autoScroll?:
    | {
        edge?: number;
        speed?: number;
        edgeProportion?: number;
        maxSpeedAt?: number;
      }
    | false;
  /**
   * Shared {@link SortableGroup} (`sortableGroup<T>()`) — give two lists the same
   * group object and items can be dragged between them.
   */
  readonly group?: SortableGroup<T>;
  /** Enable focus + arrow-key reordering (and the a11y live-region announce). @default true */
  readonly keyboard?: boolean;
  /**
   * Whether a key event is the "jump to end/start" modifier — used by the built-in
   * handler. @default Cmd on macOS, Ctrl elsewhere.
   */
  readonly jumpModifier?: (event: KeyboardEvent) => boolean;
  /**
   * Take over keyboard handling for an item, *replacing* the built-in arrow/jump
   * logic (custom keys, custom behaviour). Call `api.move(to)` to reuse the commit
   * + announce + focus-restore plumbing, or ignore it and do your own thing. Runs
   * only while `keyboard` is enabled; `keyboard: false` disables keys entirely.
   */
  readonly onKeyboardKeydown?: (
    event: KeyboardEvent,
    api: ReorderKeyboardApi<T>,
  ) => void;
  /**
   * Screen-reader message after a keyboard move, or `false` to disable announcements
   * entirely (no live region is created for this list). @default `Moved to position N of M`.
   */
  readonly announceMove?:
    | false
    | ((event: { item: T; from: number; to: number; total: number }) => string);
  /** Called after a same-list reorder commits. */
  readonly onReorder?: (event: {
    from: number;
    to: number;
    items: readonly T[];
  }) => void;
  /**
   * Whether an item dragged from another list in the group may be dropped here.
   * Return `false` to reject (the engine then resolves the next innermost
   * accepting container) — e.g. a tree node dropped into its own subtree.
   * @default always accepts
   */
  readonly canReceive?: (item: T) => boolean;
  /** Called on the SOURCE list after an item is dragged out into another list. */
  readonly onItemLeft?: (event: { item: T; from: number; to: number }) => void;
  /** Called on the TARGET list after an item arrives from another list. */
  readonly onItemArrived?: (event: { item: T; index: number }) => void;
};

/**
 * Native-engine-only reorderable options — foreign-payload insert via a pragmatic
 * drop target. Forbidden (typed `never`) when `engine: 'pointer'`.
 */
type ReorderableNativeOptions<T> = {
  /**
   * Accept items dragged from OUTSIDE any reorderable (e.g. a palette `draggable`
   * whose payload differs from `T`). `accepts` qualifies the raw payload; `create`
   * maps it to a list item at the resolved index.
   */
  readonly insert?: {
    accepts: (data: unknown) => boolean;
    create: (data: unknown, index: number) => T;
  };
  /** Called after a foreign payload is inserted via `insert`. */
  readonly onItemInserted?: (event: { item: T; index: number }) => void;
};

/**
 * Reorderable options, discriminated by `engine`. Omit `engine` (or `'native'`) for
 * the indicator engine + foreign `insert`; `'pointer'` is the FLIP engine and
 * *forbids* the native-only `insert` / `onItemInserted` at compile time. Shared
 * options work with both.
 */
export type ReorderableOptions<T, K> =
  | (ReorderableSharedOptions<T, K> &
      ReorderableNativeOptions<T> & { readonly engine?: 'native' })
  | (ReorderableSharedOptions<T, K> & { readonly engine: 'pointer' } & {
        readonly [Key in keyof ReorderableNativeOptions<T>]?: never;
      });

/** @internal Flat view (all fields) for the factory to read without narrowing. */
export type ReorderableOptionsAll<T, K> = ReorderableSharedOptions<T, K> &
  ReorderableNativeOptions<T> & { readonly engine?: DragEngine };

export type ReorderableItemState<K = unknown> = {
  readonly itemKey: Signal<K>;
  readonly index: Signal<number>;
  readonly isSource: Signal<boolean>;
  readonly transform: Signal<number>;
  readonly transformCss: Signal<string>;
  readonly transitionCss: Signal<string>;
};

/**
 * What `connectReorderableItem` returns: the per-item state plus the DOM bindings
 * the item directive wires to its host — so the directive holds no logic of its
 * own, just `[attr.tabindex]="state.tabIndex()"` / `(keydown)="state.onKeydown($event)"`.
 */
export type ReorderableItemBinding<K = unknown> = ReorderableItemState<K> & {
  /** `0` when keyboard reordering is enabled, else `null`. */
  readonly tabIndex: Signal<number | null>;
  /** Focus + arrows: move one step; jump-modifier + arrow: to the start/end. */
  onKeydown(event: KeyboardEvent): void;
};

/** What `connectReorderableContainer` returns for the directive to bind. */
export type ReorderableContainerBinding = {
  /** Trailing space (px) the opening cross-list gap needs — bind to `padding-bottom`. */
  readonly reservedSpace: Signal<number>;
};

/**
 * The reactive controller behind a sortable list. Also a {@link SortableGroupMember}
 * so it can participate in cross-list groups. Reordering is a single splice on
 * the source signal at drop — no parallel order state, array untouched mid-drag.
 */
export type ReorderableController<T, K = unknown> = SortableGroupMember<T> & {
  readonly items: Signal<readonly T[]>;
  readonly key: (item: T) => K;
  /** Reactive key→index map for O(1) index lookups (recomputed once per source change). */
  readonly indexMap: Signal<ReadonlyMap<K, number>>;
  readonly axis: Axis;
  /** Which engine drives this list — `'pointer'` (FLIP) or `'native'` (indicator). */
  readonly engine: DragEngine;
  /** The shared cross-list group, if any (same object ⇒ items can move between lists). */
  readonly group?: SortableGroup<T>;
  /** @internal stable identity tagged on this list's native drags (engine: 'native'). */
  readonly listId: symbol;
  /** @internal the native engine's active insert slot, derived from the container's registered source; items read it for the indicator. */
  readonly nativeInsert: Signal<number | null>;
  /** @internal the native container registers its `activeInsert` computed as the source of `nativeInsert` (or `null` to clear on teardown). */
  setNativeInsert(source: Signal<number | null> | null): void;
  /** Identity of the item being dragged out of THIS list, or `null`. */
  readonly activeKey: Signal<K | null>;
  /** Same-list insert index, or `-1` when idle. */
  readonly insertIndex: Signal<number>;
  /** Trailing space (px) to reserve while this list is the cross-list target opening a gap (so it doesn't overflow). */
  readonly reservedSpace: Signal<number>;
  /** Whether focus + arrow-key reordering is enabled. */
  readonly keyboard: boolean;
  /** Whether a key event is the jump-to-end/start modifier. */
  readonly jumpModifier: (event: KeyboardEvent) => boolean;
  /** Custom keyboard handler that replaces the built-in arrow/jump logic, if any. */
  readonly onKeyboardKeydown?: (
    event: KeyboardEvent,
    api: ReorderKeyboardApi<T>,
  ) => void;
  /** The screen-reader message for a keyboard move, or `null` when announcements are disabled. */
  readonly announceMove:
    | ((event: { item: T; from: number; to: number; total: number }) => string)
    | null;
  /** Commit a same-list move (keyboard reorder) — splice + `onReorder`. */
  moveItem(from: number, to: number): void;
  /** @internal remove an item leaving for another list — splice + `onItemLeft` (native cross-list). */
  takeOut(item: T, to: number): void;
  /** Accept foreign (palette) payloads: `accepts` qualifies, `create` maps to `T`. */
  readonly insert?: {
    accepts: (data: unknown) => boolean;
    create: (data: unknown, index: number) => T;
  };
  /** @internal map + insert a foreign payload at `index` — splice + `onItemInserted`. */
  insertForeign(data: unknown, index: number): void;
  /** @internal main-axis scroll travelled since drag start (auto-scroll compensation). */
  setScrollDelta(delta: number): void;
  /** Resolved auto-scroll config, or `null` when disabled. `edge`/`speed` are defaulted; the rest pass through to the plugin. */
  readonly autoScroll: {
    edge: number;
    speed: number;
    edgeProportion?: number;
    maxSpeedAt?: number;
  } | null;
  /** Resolved animation config, or `null` when disabled (native FLIP-on-commit / pointer glide). */
  readonly animation: { duration: number; easing: string } | null;
  itemState(item: () => T): ReorderableItemState<K>;
  /** @internal item DOM registration (both directions). */
  register(key: K, el: HTMLElement): void;
  /** @internal */
  unregister(key: K, el: HTMLElement): void;
  keyForElement(el: HTMLElement): K | undefined;
  /** @internal the container element, for cross-list bounds. */
  setContainer(el: HTMLElement | null): void;
  /** Pure drag-start from a measured geometry. Unit-testable without DOM. */
  begin(key: K, geometry: DragGeometry, startMain: number): void;
  /** @internal DOM edge: measure from the registry, then {@link begin}. */
  beginGesture(key: K, start: { x: number; y: number }): void;
  /** @internal feed a pointer move (viewport coords). */
  move(point: { x: number; y: number }): void;
  /** @internal end the drag, committing reorder or cross-list transfer. */
  end(): void;
  /** @internal leave the group. */
  dispose(): void;
};
