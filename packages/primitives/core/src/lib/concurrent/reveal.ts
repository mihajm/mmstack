// inspired by SolidJS 2.0's Reveal — https://github.com/solidjs/solid
import {
  computed,
  DestroyRef,
  ElementRef,
  inject,
  InjectionToken,
  linkedSignal,
  type Provider,
  signal,
  type Signal,
  type WritableSignal,
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
  /**
   * Mark the slot's boundary as rendered. Until then the slot counts as pending for every order and
   * its state function is not read, so a state seen before the boundary's inputs and content are in
   * place can never release it. Call it from the boundary's `ngAfterViewInit`. A slot that is never
   * mounted holds every slot after it. Idempotent; does nothing after `unregister`.
   */
  mount(): void;
  /** Leave the coordinator. Slots behind this one may be released by it. */
  unregister(): void;
}

/**
 * The element a slot's boundary renders as, as far as ordering needs it. A DOM `Node` satisfies it;
 * a coordinator used without the DOM registers slots without one.
 */
export interface RevealHost {
  readonly isConnected: boolean;
  compareDocumentPosition(other: RevealHost): number;
}

/**
 * Schedules when sibling boundaries show their content. Presentation only: it never delays
 * loading, registration, or anything a slot's content does while hidden.
 */
export interface RevealCoordinator {
  /**
   * Join as a slot. With a `host`, the slot takes its place in document order; a slot whose host is
   * not in the document neither holds other slots nor shows. When no slot has a host, slots are
   * ordered by registration.
   */
  register(state: () => RevealSlotState, host?: RevealHost | null): RevealSlot;
  /** Gated slots render nothing instead of their placeholder. */
  readonly collapsed: Signal<boolean>;
  /**
   * Hosts may have moved, left or rejoined the document without any slot changing: the next read
   * re-reads their positions. `MmReveal` calls it after every render; call it yourself only when
   * driving a coordinator over the DOM without `MmReveal`.
   */
  relayout(): void;
}

type Entry = {
  readonly state: () => RevealSlotState;
  readonly mounted: WritableSignal<boolean>;
  readonly host: RevealHost | null;
};

/** One fold: who is released, the order it used, and whether it had to keep the previous one. */
type Fold = {
  readonly released: ReadonlySet<Entry>;
  readonly ordered: readonly Entry[];
  readonly held: boolean;
};

const EMPTY: Fold = { released: new Set(), ordered: [], held: false };

// Node.DOCUMENT_POSITION_* (the `Node` global may be absent on the server)
const DISCONNECTED = 1;
const PRECEDING = 2;
const FOLLOWING = 4;

/** What the coordinator sees of a slot: its state once mounted, pending before. */
const effective = (e: Entry): RevealSlotState =>
  e.mounted() ? e.state() : 'pending';

const settledNow = (state: RevealSlotState, onError: RevealOnError) =>
  state === 'ready' || (onError === 'settled' && state === 'failed');

function inOrder<T>(list: readonly T[], order: RevealOrder): readonly T[] {
  return order === 'backwards' ? [...list].reverse() : list;
}

/**
 * The slots that take part, in order. No host anywhere: every slot, by registration. Otherwise the
 * slots whose host is in the document (read live), in document order, a shared host by registration
 * (the sort is stable). Hosts in different trees (a shadow root) cannot be ordered: `hold`.
 */
function participate(list: readonly Entry[]): {
  list: readonly Entry[];
  hold: boolean;
} {
  if (!list.some((e) => e.host)) return { list, hold: false };
  const placed = list.filter((e) => e.host?.isConnected);
  const first = placed[0]?.host;
  if (
    first &&
    placed.some(
      (e) =>
        e.host !== first &&
        first.compareDocumentPosition(e.host as RevealHost) & DISCONNECTED,
    )
  )
    return { list: placed, hold: true };
  return {
    list: [...placed].sort((a, b) => {
      if (a.host === b.host) return 0;
      const pos = (a.host as RevealHost).compareDocumentPosition(
        b.host as RevealHost,
      );
      return pos & FOLLOWING ? -1 : pos & PRECEDING ? 1 : 0;
    }),
    hold: false,
  };
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function fold(
  entries: readonly Entry[],
  part: { list: readonly Entry[]; hold: boolean },
  states: ReadonlyMap<Entry, RevealSlotState>,
  prev: Fold,
  order: RevealOrder,
  onError: RevealOnError,
): Fold {
  const live = new Set(entries);
  const out = new Set<Entry>();
  for (const e of prev.released) if (live.has(e)) out.add(e);
  let next: Fold;
  if (part.hold) {
    next = {
      released: out,
      ordered: prev.ordered.filter((e) => live.has(e)),
      held: true,
    };
  } else {
    const list = part.list;
    const settled = (e: Entry) =>
      settledNow(states.get(e) ?? 'pending', onError);
    if (order === 'together') {
      if (list.every((e) => out.has(e) || settled(e)))
        for (const e of list) out.add(e);
    } else
      for (const e of inOrder(list, order)) {
        if (out.has(e)) continue;
        if (!settled(e)) break;
        out.add(e);
      }
    next = { released: out, ordered: list, held: false };
  }
  return next.held === prev.held &&
    next.released.size === prev.released.size &&
    [...next.released].every((e) => prev.released.has(e)) &&
    sameList(next.ordered, prev.ordered)
    ? prev
    : next;
}

/**
 * Create a reveal coordinator. Slots count as pending until mounted (see {@link RevealSlot.mount})
 * and are ordered by document position when they have hosts, by registration when none does. A
 * slot is released (may show content) once it is ready, or failed under `onError: 'settled'`, and
 * every slot before it in order has been released; under `together` every slot is released at once
 * when all of them are. A released slot stays released even if it suspends again, or leaves the
 * document and comes back; its own boundary then shows its placeholder or busy state as usual.
 */
export function createRevealCoordinator(
  opt?: RevealOptions,
): RevealCoordinator {
  const order = computed(() => opt?.order?.() ?? 'forwards');
  const onError = computed(() => opt?.onError?.() ?? 'settled');
  const entries = signal<readonly Entry[]>([]);
  const layout = signal(0);

  const released = linkedSignal<
    {
      list: readonly Entry[];
      part: { list: readonly Entry[]; hold: boolean };
      states: ReadonlyMap<Entry, RevealSlotState>;
      order: RevealOrder;
      onError: RevealOnError;
    },
    Fold
  >({
    source: () => {
      layout();
      const list = entries();
      // one snapshot: positions are read here, once per fold
      const part = participate(list);
      return {
        list,
        part,
        states: new Map(part.list.map((e) => [e, effective(e)])),
        order: order(),
        onError: onError(),
      };
    },
    computation: (src, prev) =>
      fold(
        src.list,
        src.part,
        src.states,
        prev?.value ?? EMPTY,
        src.order,
        src.onError,
      ),
  });

  const gatedFor = (entry: Entry): boolean => {
    const f = released();
    if (f.released.has(entry)) return false;
    if (f.held || !f.ordered.includes(entry)) return true;
    if (order() === 'together') return settledNow(effective(entry), onError());
    for (const e of inOrder(f.ordered, order())) {
      if (e === entry) return false;
      if (!f.released.has(e)) return true;
    }
    return false;
  };

  const collapsed = computed(() => opt?.collapsed?.() ?? false);

  return {
    collapsed,
    relayout: () => layout.update((v) => v + 1),
    register(state, host = null) {
      const entry: Entry = { state, mounted: signal(false), host };
      let left = false;
      entries.update((list) => [...list, entry]);
      return {
        released: computed(() => released().released.has(entry)),
        gated: computed(() => gatedFor(entry)),
        collapsed,
        mount: () => {
          if (!left) entry.mounted.set(true);
        },
        unregister: () => {
          left = true;
          entries.update((list) => list.filter((e) => e !== entry));
        },
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
 * boundary (a directive or component, so the slot takes its host element's place in document
 * order) that also provides {@link severReveal}, and call the slot's `mount()` from the boundary's
 * `ngAfterViewInit`.
 */
export function injectRevealSlot(
  state: () => RevealSlotState,
): RevealSlot | null {
  const coordinator = inject(REVEAL, { optional: true, skipSelf: true });
  if (!coordinator) return null;
  const host = inject(ElementRef, { optional: true })?.nativeElement as
    RevealHost | undefined;
  const slot = coordinator.register(state, host ?? null);
  inject(DestroyRef).onDestroy(() => slot.unregister());
  return slot;
}
