import { computed, type Signal, signal, untracked } from '@angular/core';
import { mutable } from '@mmstack/primitives';
import { type Axis, containsPoint, type RectLike } from './geometry';

const GROUP_INTERNALS = Symbol('@mmstack/dnd:sortable-group-internals');

export function getGroupInternals<T = unknown>(group: SortableGroup<T>) {
  return group[GROUP_INTERNALS];
}

/**
 * What the group needs from a member list to coordinate a cross-list drag. A
 * `reorderable` controller satisfies this; tests can supply a minimal stub.
 */
export type SortableGroupMember<T = unknown> = {
  /** The member container's viewport rect, or `null` before mounted. Served from a cache during a drag. */
  bounds(): RectLike | null;
  /** Snapshot the container rect into the cache (once at drag start, so `bounds()` reads stay DOM-free). */
  refreshBounds(): void;
  /** This list's item centers (at rest) + axis — for computing the insert when it's the cross-list target. */
  measure(): { centers: readonly number[]; axis: Axis };
  /** Insert an item arriving from another list, and fire this list's own arrival callback. */
  insertAt(item: T, index: number): void;
  /**
   * May an item dragged from another member be dropped here? Used to reject
   * invalid targets — e.g. a tree node dropped into its own subtree (a cycle).
   * Missing ⇒ always accepts.
   */
  canReceive?(item: T): boolean;
};

/** A resolved cross-list drag, mirrored into the group's decomposed signals. */
export type SortableActive<T = unknown> = {
  source: SortableGroupMember<T>;
  target: SortableGroupMember<T>;
  sourceIndex: number;
  insertIndex: number;
  footprint: number;
};

/**
 * Links sibling sortable lists so an item can be dragged from one into another.
 * Create one and pass it to each list's `reorderable({ group })`. It is the
 * shared registry (no magic strings, no global namespace) and holds the active
 * cross-list drag so every member can react to it.
 */
export type SortableGroup<T = unknown> = {
  /** @internal a member joins on creation; returns its index for O(1) unregister. */
  register(member: SortableGroupMember<T>): number;
  /** @internal */
  unregister(member: SortableGroupMember<T>, idx?: number): void;
  /** Current members, in registration order (read-path copy). */
  readonly members: Signal<readonly SortableGroupMember<T>[]>;
  /**
   * The member whose container contains the viewport point, or `null`. On
   * overlap the **geometrically innermost** (smallest containing rect) wins, so
   * a container nested inside another resolves correctly at any depth. `accept`
   * filters candidates (e.g. cycle guard) — the innermost *accepted* one wins.
   */
  targetAt(
    x: number,
    y: number,
    accept?: (member: SortableGroupMember<T>) => boolean,
  ): SortableGroupMember<T> | null;

  /** internal signals + setters, handled with care, so not part of the public surface */
  readonly [GROUP_INTERNALS]: {
    readonly members: Signal<readonly SortableGroupMember<T>[]>;
    /** decomposed so each is a scalar leaf — a move that doesn't change a field doesn't notify its readers */
    readonly activeSource: Signal<SortableGroupMember<T> | null>;
    readonly activeTarget: Signal<SortableGroupMember<T> | null>;
    readonly activeSourceIndex: Signal<number>;
    readonly activeInsertIndex: Signal<number>;
    readonly activeFootprint: Signal<number>;
    setActive(active: SortableActive<T>): void;
    clearActive(): void;
  };
};

export type SortableGroupOptions<T = unknown> = {
  /**
   * How to tell whether two members are the same (for dedup on register and
   * lookup on unregister). Defaults to reference identity (`Object.is`).
   */
  equal?: (a: SortableGroupMember<T>, b: SortableGroupMember<T>) => boolean;
};

export function sortableGroup<T = unknown>(
  options?: SortableGroupOptions<T>,
): SortableGroup<T> {
  const members = mutable<SortableGroupMember<T>[]>([]);
  const eq = options?.equal ?? Object.is;
  const indexOf = (
    list: readonly SortableGroupMember<T>[],
    member: SortableGroupMember<T>,
  ): number => {
    for (let i = 0; i < list.length; i++) if (eq(list[i], member)) return i;
    return -1;
  };

  const activeSource = signal<SortableGroupMember<T> | null>(null);
  const activeTarget = signal<SortableGroupMember<T> | null>(null);
  const activeSourceIndex = signal(-1);
  const activeInsertIndex = signal(-1);
  const activeFootprint = signal(0);

  return {
    register: (member) => {
      const current = untracked(members);
      const existing = indexOf(current, member);
      if (existing !== -1) return existing;

      const idx = current.length; // capture BEFORE the in-place push mutates it
      members.inline((m) => m.push(member));
      return idx;
    },
    unregister: (member, idx = -1) => {
      const current = untracked(members);
      const actualIdx =
        idx >= 0 && idx < current.length && eq(current[idx], member)
          ? idx
          : indexOf(current, member);
      if (actualIdx === -1) return;
      members.inline((m) => m.splice(actualIdx, 1));
    },
    members: computed(() => members().slice()),
    targetAt: (x, y, accept) => {
      const list = members();
      // smallest containing rect = innermost; ties → later registration wins.
      let best: SortableGroupMember<T> | null = null;
      let bestArea = Infinity;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const b = m.bounds();
        if (!b || !containsPoint(b, x, y)) continue;
        if (accept && !accept(m)) continue;
        const area = b.width * b.height;
        if (area <= bestArea) {
          best = m;
          bestArea = area;
        }
      }
      return best;
    },
    [GROUP_INTERNALS]: {
      members,
      activeSource,
      activeTarget,
      activeSourceIndex,
      activeInsertIndex,
      activeFootprint,
      setActive: (a) => {
        activeSource.set(a.source);
        activeTarget.set(a.target);
        activeSourceIndex.set(a.sourceIndex);
        activeInsertIndex.set(a.insertIndex);
        activeFootprint.set(a.footprint);
      },
      clearActive: () => {
        activeSource.set(null);
        activeTarget.set(null);
        activeSourceIndex.set(-1);
        activeInsertIndex.set(-1);
        activeFootprint.set(0);
      },
    },
  };
}

/** Type guard for the explicit group object (vs. a future string form). */
export function isSortableGroup(v: unknown): v is SortableGroup {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as SortableGroup).register === 'function' &&
    typeof (v as SortableGroup).targetAt === 'function'
  );
}
