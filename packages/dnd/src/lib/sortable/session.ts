import { computed, linkedSignal, type Signal } from '@angular/core';
import { type Axis, displacement, insertIndexTransformAware } from './geometry';

/**
 * Layout snapshot captured once at drag start. The centers and source size are
 * read from the DOM a single time (the one measurement edge) and never again
 * during the drag — the FLIP model keeps every item in flow, so these stay
 * valid as the gap opens, which is what makes the collision self-consistent.
 */
export type DragGeometry = {
  /** Index of the dragged item. */
  readonly source: number;
  /** Main-axis center of every item, ascending, cached at drag start. */
  readonly centers: readonly number[];
  /** The source's slot footprint (main-axis size + inter-item gap) — the shift each displaced sibling takes. */
  readonly footprint: number;
  /** The list's main axis. */
  readonly axis: Axis;
};

export type SortableSessionInput = {
  /** The drag's cached geometry, or `null` when idle. */
  readonly geometry: Signal<DragGeometry | null>;
  /** Pointer position projected onto the list's main axis. */
  readonly pointer: Signal<number>;
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
   */
  readonly displacementFor: (index: Signal<number>) => Signal<number>;
  /** Whether the item at `index` is the one being dragged. */
  readonly isSource: (index: Signal<number>) => Signal<boolean>;
};

/**
 * The signals-first heart of pointer sortable: turns a gesture (`pointer` +
 * `active`) and a drag-start geometry snapshot into the insert index and the
 * per-item transforms — pure derivation, no effects. The only stateful node is
 * `insertIndex`, a `linkedSignal` that carries the previous frame's value
 * forward, which the transform-aware collision needs (and seeds with the source
 * index on the first frame).
 */
export function sortableSession(input: SortableSessionInput): SortableSession {
  const deadband = input.deadband ?? 0;

  const insertIndex = linkedSignal<
    { active: boolean; geom: DragGeometry | null; pos: number },
    number
  >({
    source: () => ({
      active: input.active(),
      geom: input.geometry(),
      pos: input.pointer(),
    }),
    computation: ({ active, geom, pos }, prev) => {
      if (!active || !geom) return -1;
      const seed = prev && prev.value >= 0 ? prev.value : geom.source;
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
      if (!geom) return 0;
      return displacement(index(), geom.source, ins, geom.footprint);
    });

  const isSource = (index: Signal<number>): Signal<boolean> =>
    computed(() => input.active() && index() === source());

  return {
    active: input.active,
    source,
    insertIndex,
    displacementFor,
    isSource,
  };
}
