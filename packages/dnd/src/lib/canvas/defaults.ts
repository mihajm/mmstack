import { createDefaultsToken } from '../provide';
import type { GridSpec } from './geometry';

/**
 * DI-settable {@link canvas} defaults — the cross-cutting, non-identity
 * options (never `key`/lenses/callbacks/`selection`/`space`). A per-call
 * option always wins.
 */
export type CanvasDefaults = {
  /** Default snap grid. */
  grid?: GridSpec | (() => GridSpec | undefined);
  /** Default snapline behaviour. */
  snap?: boolean | { threshold?: number; toCanvas?: boolean };
  /** Default resize enablement/limits. */
  resize?:
    | boolean
    | {
        min?: { width?: number; height?: number };
        max?: { width?: number; height?: number };
      };
  /** Default rotate enablement/snap. */
  rotate?: boolean | { snap?: number };
  /** Default marquee enablement. */
  marquee?: boolean;
  /** Default keyboard nudging. */
  keyboard?: boolean | { step?: number; largeStep?: number };
  /** Default Shift axis lock. */
  lockAxisOnShift?: boolean;
  /** Default edge auto-scroll config (or `false` to keep it off). */
  autoScroll?:
    | { edge?: number; speed?: number; edgeProportion?: number; maxSpeedAt?: number }
    | false;
  /** Default activation distance in px. */
  activationThreshold?: number;
};

const canvasDefaults = createDefaultsToken<CanvasDefaults>(
  '@mmstack/dnd:canvas-defaults',
);
/** Register `canvas` option defaults (a per-call option always wins). */
export const provideCanvasDefaults = canvasDefaults.provide;
/** Read the `canvas` defaults (or `null`). @see {@link provideCanvasDefaults} */
export const injectCanvasDefaults = canvasDefaults.inject;
