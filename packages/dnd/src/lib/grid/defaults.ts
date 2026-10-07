import type { TouchActivation } from '../internal/touch-activation';
import { createDefaultsToken, injectTouchActivationDefault } from '../provide';
import type { ReorderableAnimation } from '../sortable/types';

/**
 * DI-settable {@link placementGrid} defaults — the cross-cutting, non-identity
 * options (never `key`/`cols`/`group`/callbacks). A per-call option always
 * wins. Inherits `touchActivation` from `provideDndDefaults` (a placement
 * grid has no `engine`).
 */
export type PlacementGridDefaults = {
  /** Default gap between cells, px. */
  gap?: number | (() => number);
  /** Default row height px (falls back to square cells). */
  rowHeight?: number | (() => number);
  /** Default compaction mode. */
  compact?: 'vertical' | 'none';
  /** Default keyboard enablement. */
  keyboard?: boolean;
  /** Default preview glide (or `false` for instant). */
  animation?: ReorderableAnimation | false;
  /** Default edge auto-scroll config (or `false` to keep it off). */
  autoScroll?:
    | { edge?: number; speed?: number; edgeProportion?: number; maxSpeedAt?: number }
    | false;
  /** Default activation distance in px. */
  activationThreshold?: number;
  /** Default touch long-press (or `false` to keep it off). */
  touchActivation?: TouchActivation | false;
  /** Default keyboard announcement (or `false` to disable). */
  announcePlace?:
    | false
    | ((event: {
        item: unknown;
        x: number;
        y: number;
        w: number;
        h: number;
      }) => string);
};

const placementGridDefaults = createDefaultsToken<PlacementGridDefaults>(
  '@mmstack/dnd:placement-grid-defaults',
  injectTouchActivationDefault,
);
/** Register `placementGrid` option defaults (a per-call option always wins). */
export const providePlacementGridDefaults = placementGridDefaults.provide;
/** Read the `placementGrid` defaults (or `null`). @see {@link providePlacementGridDefaults} */
export const injectPlacementGridDefaults = placementGridDefaults.inject;
