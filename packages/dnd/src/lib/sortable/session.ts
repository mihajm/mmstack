import { computed, linkedSignal, type Signal } from '@angular/core';
import {
  type Axis,
  displacement,
  insertIndexFromSlots,
  insertIndexTransformAware,
  type Point,
  slotOf,
} from './geometry';

/**
 * Layout snapshot captured once at drag start. The centers and source size are
 * read from the DOM a single time (the one measurement edge) and never again
 * during the drag — the FLIP model keeps every item in flow, so these stay
 * valid as the gap opens, which is what makes the collision self-consistent.
 *
 * Two layout kinds share the snapshot shape as a discriminated union:
 * - `linear` (default; a missing `kind` means linear): centers projected onto
 *   the one main axis, siblings displace by the scalar `footprint`.
 * - `wrap` (flex-wrap / grid flow): 2D centers that double as static slots;
 *   items displace by slot reassignment ({@link slotOf}), and the col/row
 *   pitch extrapolates the virtual append slot for cross-list entry.
 */
export type LinearDragGeometry = {
  readonly kind?: 'linear';
  /** Index of the dragged item. */
  readonly source: number;
  /** Main-axis center of every item, ascending, cached at drag start. */
  readonly centers: readonly number[];
  /** The source's slot footprint (main-axis size + inter-item gap) — the shift each displaced sibling takes. */
  readonly footprint: number;
  /** The list's main axis. */
  readonly axis: Axis;
};

export type WrapDragGeometry = {
  readonly kind: 'wrap';
  /** Index of the dragged item. */
  readonly source: number;
  /** 2D center of every item in reading order, cached at drag start — these ARE the slots. */
  readonly centers: readonly Point[];
  /** Median x distance between adjacent same-row centers. */
  readonly colPitch: number;
  /** Median y distance between adjacent rows. */
  readonly rowPitch: number;
};

export type DragGeometry = LinearDragGeometry | WrapDragGeometry;

export type SortableSessionInput = {
  /** The drag's cached geometry, or `null` when idle. */
  readonly geometry: Signal<DragGeometry | null>;
  /** Pointer position projected onto the list's main axis (viewport y for wrap). */
  readonly pointer: Signal<number>;
  /** Off-axis pointer position (viewport x for wrap) — only read by wrap collision. */
  readonly pointerCross?: Signal<number>;
  /** Whether a drag gesture is past its activation threshold. */
  readonly active: Signal<boolean>;
  /** Px a center must be cleared by before the insert index flips (jitter immunity). */
  readonly deadband?: number;
};

export type SortableSession = {
  /** `true` while a drag is in progress. */
  readonly active: Signal<boolean>;
  /** Index of the dragged item, or `-1` when idle. */
  readonly source: Signal<number>;
  /** Where the source will land if dropped now, or `-1` when idle. */
  readonly insertIndex: Signal<number>;
  /**
   * A per-item displacement signal (main-axis px) for the item whose live index
   * is `index`. Recomputes only when the insert index actually changes value,
   * and emits a new value only for items whose displacement changed — so a
   * boundary cross writes the DOM for the band, not the whole list.
   * Linear-mode only; wrap consumers read {@link slotFor} instead.
   */
  readonly displacementFor: (index: Signal<number>) => Signal<number>;
  /**
   * The slot the item at `index` currently occupies (wrap mode): its own index
   * while idle, the {@link slotOf} reassignment mid-drag. An integer scalar
   * leaf — an insert change from k to k′ renotifies only the items inside the
   * `[min(k,k′), max(k,k′)]` band; everyone else recomputes to the same int.
   */
  readonly slotFor: (index: Signal<number>) => Signal<number>;
  /** Whether the item at `index` is the one being dragged. */
  readonly isSource: (index: Signal<number>) => Signal<boolean>;
};

/**
 * The signals-first heart of pointer sortable: turns a gesture (`pointer` +
 * `active`) and a drag-start geometry snapshot into the insert index and the
 * per-item transforms — pure derivation, no effects. The only stateful node is
 * `insertIndex`, a `linkedSignal` that carries the previous frame's value
 * forward: the linear transform-aware collision needs it to read a settled
 * picture, the wrap collision uses it as the held slot of its 2D Schmitt
 * deadband (and both seed with the source index on the first frame).
 */
export function sortableSession(input: SortableSessionInput): SortableSession {
  const deadband = input.deadband ?? 0;
  const pointerCross = input.pointerCross ?? (() => 0);

  const insertIndex = linkedSignal<
    {
      active: boolean;
      geom: DragGeometry | null;
      pos: number;
      cross: number;
    },
    number
  >({
    source: () => {
      const geom = input.geometry();
      return {
        active: input.active(),
        geom,
        pos: input.pointer(),
        // linear collision must not depend on the off-axis coordinate
        cross: geom?.kind === 'wrap' ? pointerCross() : 0,
      };
    },
    computation: ({ active, geom, pos, cross }, prev) => {
      if (!active || !geom) return -1;
      const seed = prev && prev.value >= 0 ? prev.value : geom.source;
      if (geom.kind === 'wrap') {
        return insertIndexFromSlots(geom.centers, cross, pos, seed, deadband);
      }
      return insertIndexTransformAware(
        geom.centers,
        geom.source,
        geom.footprint,
        pos,
        seed,
        deadband,
      );
    },
  });

  const source = computed(() => input.geometry()?.source ?? -1);

  const displacementFor = (index: Signal<number>): Signal<number> =>
    computed(() => {
      const ins = insertIndex();
      if (ins < 0) return 0; // idle: depend only on the index until a drag starts
      const geom = input.geometry();
      if (!geom || geom.kind === 'wrap') return 0;
      return displacement(index(), geom.source, ins, geom.footprint);
    });

  const slotFor = (index: Signal<number>): Signal<number> =>
    computed(() => {
      const ins = insertIndex();
      if (ins < 0) return index(); // idle: an item sits in its own slot
      const geom = input.geometry();
      if (!geom) return index();
      return slotOf(index(), geom.source, ins);
    });

  const isSource = (index: Signal<number>): Signal<boolean> =>
    computed(() => input.active() && index() === source());

  return {
    active: input.active,
    source,
    insertIndex,
    displacementFor,
    slotFor,
    isSource,
  };
}
