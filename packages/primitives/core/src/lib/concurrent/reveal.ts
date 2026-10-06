// inspired by SolidJS 2.0's Reveal — https://github.com/solidjs/solid
import {
  computed,
  DestroyRef,
  inject,
  InjectionToken,
  linkedSignal,
  type Provider,
  signal,
  type Signal,
} from '@angular/core';

/** The order in which sibling boundaries may show their content. */
export type RevealOrder = 'forwards' | 'backwards' | 'together';

/**
 * Whether a failed slot counts as settled for ordering. `'settled'` (the default): a failed slot
 * shows its error and the slots after it go on. `'blocks'`: a failed slot holds the slots after it
 * (all slots under `together`) until a retry succeeds; use it when the order encodes prerequisites.
 */
export type RevealOnError = 'settled' | 'blocks';

/** A slot's own readiness, as its boundary reports it. */
export type RevealSlotState = 'pending' | 'ready' | 'failed';

export type RevealOptions = {
  readonly order?: () => RevealOrder;
  readonly onError?: () => RevealOnError;
  readonly collapsed?: () => boolean;
};

export interface RevealSlot {
  /** Whether this slot has been allowed to show its content. Once true it stays true. */
  readonly released: Signal<boolean>;
  /**
   * Whether another slot is holding this one back: the boundary shows its placeholder, or nothing
   * when the coordinator is collapsed. A slot waiting only on itself is not gated.
   */
  readonly gated: Signal<boolean>;
  /** The coordinator's `collapsed`: a gated slot renders nothing instead of its placeholder. */
  readonly collapsed: Signal<boolean>;
  /** Leave the coordinator. Slots behind this one may be released by it. */
  unregister(): void;
}

/**
 * Schedules when sibling boundaries show their content. Presentation only: it never delays
 * loading, registration, or anything a slot's content does while hidden.
 */
export interface RevealCoordinator {
  register(state: () => RevealSlotState): RevealSlot;
  /** Gated slots render nothing instead of their placeholder. */
  readonly collapsed: Signal<boolean>;
}

type Entry = { readonly state: () => RevealSlotState };

const settledNow = (state: RevealSlotState, onError: RevealOnError) =>
  state === 'ready' || (onError === 'settled' && state === 'failed');

function inOrder<T>(list: readonly T[], order: RevealOrder): readonly T[] {
  return order === 'backwards' ? [...list].reverse() : list;
}

function fold(
  entries: readonly Entry[],
  states: readonly RevealSlotState[],
  prev: ReadonlySet<Entry>,
  order: RevealOrder,
  onError: RevealOnError,
): ReadonlySet<Entry> {
  const out = new Set<Entry>();
  for (const e of entries) if (prev.has(e)) out.add(e);
  if (order === 'together') {
    if (entries.every((e, i) => out.has(e) || settledNow(states[i], onError)))
      for (const e of entries) out.add(e);
  } else {
    const idx = inOrder(
      entries.map((_, i) => i),
      order,
    );
    for (const i of idx) {
      if (out.has(entries[i])) continue;
      if (!settledNow(states[i], onError)) break;
      out.add(entries[i]);
    }
  }
  return out.size === prev.size && [...out].every((e) => prev.has(e))
    ? prev
    : out;
}

/**
 * Create a reveal coordinator. Slots are ordered by registration. A slot is released (may show
 * content) once it is ready, or failed under `onError: 'settled'`, and every slot before it in
 * order has been released; under `together` every slot is released at once when all of them are.
 * A released slot stays released even if it suspends again; its own boundary then shows its
 * placeholder or busy state as usual.
 */
export function createRevealCoordinator(
  opt?: RevealOptions,
): RevealCoordinator {
  const order = computed(() => opt?.order?.() ?? 'forwards');
  const onError = computed(() => opt?.onError?.() ?? 'settled');
  const entries = signal<readonly Entry[]>([]);

  const released = linkedSignal<
    {
      list: readonly Entry[];
      states: readonly RevealSlotState[];
      order: RevealOrder;
      onError: RevealOnError;
    },
    ReadonlySet<Entry>
  >({
    source: () => {
      const list = entries();
      return {
        list,
        states: list.map((e) => e.state()),
        order: order(),
        onError: onError(),
      };
    },
    computation: (src, prev) =>
      fold(
        src.list,
        src.states,
        prev?.value ?? new Set(),
        src.order,
        src.onError,
      ),
  });

  const gatedFor = (entry: Entry): boolean => {
    const rel = released();
    if (rel.has(entry)) return false;
    if (order() === 'together') return settledNow(entry.state(), onError());
    const list = inOrder(entries(), order());
    for (const e of list) {
      if (e === entry) return false;
      if (!rel.has(e)) return true;
    }
    return false;
  };

  const collapsed = computed(() => opt?.collapsed?.() ?? false);

  return {
    collapsed,
    register(state) {
      const entry: Entry = { state };
      entries.update((list) => [...list, entry]);
      return {
        released: computed(() => released().has(entry)),
        gated: computed(() => gatedFor(entry)),
        collapsed,
        unregister: () =>
          entries.update((list) => list.filter((e) => e !== entry)),
      };
    },
  };
}

/**
 * The nearest reveal coordinator. Every boundary provides `null` for its own content, so only
 * boundaries with no boundary between them and the coordinator become its slots.
 */
export const REVEAL = new InjectionToken<RevealCoordinator | null>(
  '@mmstack/primitives:reveal',
);

/** Provide on a boundary so the boundaries inside it are not slots of an outer coordinator. */
export function severReveal(): Provider {
  return { provide: REVEAL, useValue: null };
}

/**
 * For boundary authors: join the nearest reveal coordinator above this boundary as a slot,
 * leaving it when the boundary is destroyed. Returns `null` when there is none. Call it from a
 * boundary that also provides {@link severReveal}.
 */
export function injectRevealSlot(
  state: () => RevealSlotState,
): RevealSlot | null {
  const coordinator = inject(REVEAL, { optional: true, skipSelf: true });
  if (!coordinator) return null;
  const slot = coordinator.register(state);
  inject(DestroyRef).onDestroy(() => slot.unregister());
  return slot;
}
