import { createDefaultsToken, injectDndDefaults } from '../provide';
import type { DragEngine } from '../session';
import type { Axis } from './geometry';
import type { ReorderableAnimation } from './types';

/**
 * DI-settable `reorderable` defaults — the cross-cutting, non-identity options
 * (never `key`/`group`/callbacks). Inherits `engine` from {@link provideDndDefaults};
 * a per-call option always wins.
 */
export type ReorderableDefaults = {
  /** Default drag engine for lists. */
  engine?: DragEngine;
  /** Default list main axis. */
  axis?: Axis;
  /** Default px a center must be cleared by before the insert index flips. */
  deadband?: number;
  /** Default during-drag reflow glide (or `false` for instant). */
  animation?: ReorderableAnimation | false;
  /** Default edge auto-scroll config (or `false` to keep it off). */
  autoScroll?:
    | { edge?: number; speed?: number; edgeProportion?: number; maxSpeedAt?: number }
    | false;
  /** Default keyboard-reorder enablement. */
  keyboard?: boolean;
  /** Default jump-to-start/end modifier predicate. */
  jumpModifier?: (event: KeyboardEvent) => boolean;
  /** Default keyboard-move announcement (or `false` to disable). */
  announceMove?:
    | false
    | ((event: { item: unknown; from: number; to: number; total: number }) => string);
};

const reorderableDefaults = createDefaultsToken<ReorderableDefaults>(
  '@mmstack/dnd:reorderable-defaults',
  injectDndDefaults,
);
/** Register `reorderable` option defaults (a per-call option always wins). */
export const provideReorderableDefaults = reorderableDefaults.provide;
/** Read the `reorderable` defaults (or `null`). @see {@link provideReorderableDefaults} */
export const injectReorderableDefaults = reorderableDefaults.inject;
