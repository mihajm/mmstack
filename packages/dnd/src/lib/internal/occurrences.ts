import { computed, type Signal, signal, untracked } from '@angular/core';
import { type Handle, type HandleTable, handles } from '@mmstack/primitives';

/** The source as seen by one controller: its items and each occurrence's handle, by position. */
export type Occurrences<T, K> = {
  readonly items: readonly T[];
  readonly handles: readonly Handle<K>[];
  /** Handle → position. */
  readonly index: ReadonlyMap<Handle<K>, number>;
};

/**
 * Occurrence identity for a keyed list (dnd's lists and grids). Every item gets
 * the handle `@mmstack/primitives`' `handles` assigns it: its raw key while that
 * key never had duplicates, an opaque per-occurrence handle once it did. Rendered
 * elements bind to occurrences: by item reference first (a reference repeated
 * binds its occurrences in registration order), by key otherwise.
 */
export function occurrences<T, K>(
  source: Signal<readonly T[]>,
  key: (item: T) => K,
) {
  // the handle table remembers the previous observed state; it is reused
  // (double-buffered) by the next call, so everything published is copied
  let table: HandleTable<T, K> | null = null;
  const state = computed<Occurrences<T, K>>(() => {
    const items = source();
    const next = handles(table, items, key);
    table = next.table;
    const hs = next.table.handles.slice();
    const index = new Map<Handle<K>, number>();
    for (let i = 0; i < hs.length; i++) index.set(hs[i], i);
    return { items, handles: hs, index };
  });

  // element → what it was registered with; Map order = registration order
  const rows = new Map<HTMLElement, { key: K; item?: T }>();
  const version = signal(0);

  const bindings = computed(() => {
    const { items, handles: hs } = state();
    version();
    const byEl = new Map<HTMLElement, Handle<K>>();
    const byHandle = new Map<Handle<K>, HTMLElement>();
    const taken = new Set<number>();
    const refs = new Map<T, number[]>();
    const keys = new Map<K, number[]>();
    for (let i = 0; i < items.length; i++) {
      const r = refs.get(items[i]);
      if (r) r.push(i);
      else refs.set(items[i], [i]);
      const k = key(items[i]);
      const q = keys.get(k);
      if (q) q.push(i);
      else keys.set(k, [i]);
    }
    const bind = (el: HTMLElement, at: readonly number[] | undefined) => {
      if (!at) return false;
      for (const i of at) {
        if (taken.has(i)) continue;
        taken.add(i);
        byEl.set(el, hs[i]);
        byHandle.set(hs[i], el);
        return true;
      }
      return false;
    };
    // 1. by reference, in registration order
    const byKey: [HTMLElement, K][] = [];
    for (const [el, row] of rows) {
      if (row.item === undefined || !bind(el, refs.get(row.item))) {
        byKey.push([el, row.key]);
      }
    }
    // 2. by key for the rest; the LATEST registration wins a contested key
    //    (a re-rendered row registers before its predecessor unregisters)
    for (let j = byKey.length - 1; j >= 0; j--) {
      bind(byKey[j][0], keys.get(byKey[j][1]));
    }
    return { byEl, byHandle };
  });

  return {
    state,
    indexMap: computed(() => state().index),
    /** The occurrence `item` is: its reference's first position, else its key's first. Reactive. */
    handleOf(item: T): Handle<K> | undefined {
      const { items, handles: hs } = state();
      let i = items.indexOf(item);
      if (i < 0) {
        const k = key(item);
        i = items.findIndex((it) => key(it) === k);
      }
      return i < 0 ? undefined : hs[i];
    },
    handleAt(i: number): Handle<K> | undefined {
      return state().handles[i];
    },
    register(k: K, el: HTMLElement, item?: T): void {
      rows.delete(el);
      rows.set(el, { key: k, item });
      untracked(() => version.update((v) => v + 1));
    },
    unregister(k: K, el: HTMLElement): void {
      if (rows.get(el)?.key !== k) return; // identity guard: a stale key cannot evict a re-registration
      rows.delete(el);
      untracked(() => version.update((v) => v + 1));
    },
    keyForElement(el: HTMLElement): Handle<K> | undefined {
      return bindings().byEl.get(el);
    },
    elementFor(h: Handle<K>): HTMLElement | undefined {
      return bindings().byHandle.get(h);
    },
  };
}

export type OccurrenceIdentity<T, K> = ReturnType<typeof occurrences<T, K>>;
