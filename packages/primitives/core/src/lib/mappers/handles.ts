/**
 * An opaque identity for one occurrence of a key that is (or once was) duplicated. Compared by
 * reference; `n` is never reused within one handle table's life, and a handle is never a string
 * built from the key, so it cannot collide with a user key such as `'a#1'`.
 *
 * Identity is the reference: a handle that crosses a structured-clone boundary (a worker,
 * `postMessage`, JSON) comes back as a plain object that {@link isKeyHandle} rejects and that
 * matches no entry.
 */
export type KeyHandle<K> = { readonly key: K; readonly n: number };

/** An entry's lifetime identity: its raw key, or a {@link KeyHandle} once duplicates were seen. */
export type Handle<K> = K | KeyHandle<K>;

const minted = new WeakSet<object>();

/** `true` for a handle minted by {@link handles}; a user object shaped `{ key, n }` is not one. */
export function isKeyHandle(value: unknown): value is KeyHandle<unknown> {
  return typeof value === 'object' && value !== null && minted.has(value);
}

/**
 * One observed state: the items, their keys and their handles, plus the minting counter.
 *
 * Retention: a table returned by {@link handles} is reused by the next call that takes it as
 * `prev` (like `pooled`). Its arrays stay intact for exactly one further call, so the previous
 * state can be read while the next one is reconciled; copy anything kept longer.
 */
export type HandleTable<T, K> = {
  readonly items: readonly T[];
  readonly keys: readonly K[];
  readonly handles: readonly Handle<K>[];
  readonly next: number;
};

const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (a !== a && b !== b);

/** One side's arrays: the item snapshot, keys, handles, and each key's occurrences as a chain. */
class Side<T, K> {
  readonly items: T[] = [];
  readonly keys: K[] = [];
  readonly handles: Handle<K>[] = [];
  /** First position of each key. */
  readonly first = new Map<K, number>();
  /** Next position with the same key, or -1. */
  readonly chain: number[] = [];

  link(): void {
    this.first.clear();
    const n = this.keys.length;
    this.chain.length = n;
    for (let i = n - 1; i >= 0; i--) {
      const at = this.first.get(this.keys[i]);
      this.chain[i] = at === undefined ? -1 : at;
      this.first.set(this.keys[i], i);
    }
  }
}

/** A table that owns its two sides and every scratch structure, reused across calls. */
class Table<T, K> implements HandleTable<T, K> {
  cur = new Side<T, K>();
  spare = new Side<T, K>();
  next = 0;
  readonly used: boolean[] = [];
  readonly assigned: boolean[] = [];
  readonly refFirst = new Map<T, number>();
  readonly refLast = new Map<T, number>();
  readonly refNext: number[] = [];
  readonly nextRefs = new Set<T>();
  readonly fresh: number[] = [];
  readonly remainder: number[] = [];
  readonly destroyed: Handle<K>[] = [];
  readonly result: { table: HandleTable<T, K>; destroyed: Handle<K>[] } = {
    table: this,
    destroyed: this.destroyed,
  };

  get items(): readonly T[] {
    return this.cur.items;
  }
  get keys(): readonly K[] {
    return this.cur.keys;
  }
  get handles(): readonly Handle<K>[] {
    return this.cur.handles;
  }

  static from<T, K>(prev: HandleTable<T, K> | null | undefined): Table<T, K> {
    if (prev instanceof Table) return prev as Table<T, K>;
    const table = new Table<T, K>();
    if (prev) {
      table.cur.items.push(...prev.items);
      table.cur.keys.push(...prev.keys);
      table.cur.handles.push(...prev.handles);
      table.cur.link();
      table.next = prev.next;
    }
    return table;
  }
}

/**
 * Assigns each item a handle that follows the occurrence it corresponds to, not its slot: the
 * previous table in, the next table out, plus the handles that retired (`destroyed`, in the
 * previous table's order). The table snapshots `items`, so mutating the array passed in
 * afterwards changes nothing.
 *
 * Per key:
 * - one occurrence on each side keeps its handle; a key seen for the first time, once, gets its
 *   raw key as the handle, unless that key is itself a {@link KeyHandle} (it then gets an opaque
 *   handle, so handles fed back in as keys never collide with the handles they name);
 * - otherwise, an item reference found on both sides keeps that reference's previous handles in
 *   order and creates or retires only the difference in its count (the occurrences of one object
 *   cannot be told apart, so they never swap);
 * - the remaining fresh objects take the remaining previous handles in order when the two counts
 *   are equal (the immutable-update convention); when the counts differ nothing shows which
 *   occurrence survived, so every remaining previous handle retires and every remaining new
 *   occurrence gets a fresh opaque handle.
 *
 * A handle lasts for the entry's life: it is not reset to the raw key when the key becomes unique
 * again. Histories that stay duplicate-free get exactly their raw keys.
 *
 * Cost: the table owns two sides and its scratch, so a warmed table allocates nothing per call
 * except newly minted handles. Unchanged items and keys return the previous table as it is. The
 * returned table and `destroyed` are reused by the next call (see {@link HandleTable}).
 */
export function handles<T, K>(
  prev: HandleTable<T, K> | null | undefined,
  items: readonly T[],
  keyOf: (item: T) => K,
): {
  readonly table: HandleTable<T, K>;
  readonly destroyed: readonly Handle<K>[];
} {
  const t = Table.from(prev);
  const was = t.cur;
  const now = t.spare;
  const n = items.length;
  const pn = was.items.length;

  now.keys.length = n;
  for (let i = 0; i < n; i++) now.keys[i] = keyOf(items[i]);
  t.destroyed.length = 0;

  if (n === pn) {
    let same = true;
    for (let i = 0; same && i < n; i++)
      same =
        items[i] === was.items[i] && sameValueZero(now.keys[i], was.keys[i]);
    if (same) return t.result;
  }

  now.items.length = n;
  for (let i = 0; i < n; i++) now.items[i] = items[i];
  now.link();

  const out = now.handles;
  out.length = n;
  const used = t.used;
  used.length = pn;
  used.fill(false);
  const assigned = t.assigned;
  assigned.length = n;
  assigned.fill(false);
  const take = (to: number, from: number) => {
    out[to] = was.handles[from];
    assigned[to] = true;
    used[from] = true;
  };

  for (let i = 0; i < n; i++) {
    const key = now.keys[i];
    if (now.first.get(key) !== i) continue;
    const single = now.chain[i] === -1;
    const b = was.first.get(key);
    if (b === undefined) {
      if (single && !isKeyHandle(key)) {
        out[i] = key;
        assigned[i] = true;
      }
      continue;
    }
    if (single && was.chain[b] === -1) {
      take(i, b);
      continue;
    }

    // a key duplicated on either side: group its occurrences by item reference
    const { refFirst, refLast, refNext, nextRefs, fresh, remainder } = t;
    refFirst.clear();
    refLast.clear();
    refNext.length = pn;
    for (let p = b; p !== -1; p = was.chain[p]) {
      const ref = was.items[p];
      refNext[p] = -1;
      const last = refLast.get(ref);
      if (last === undefined) refFirst.set(ref, p);
      else refNext[last] = p;
      refLast.set(ref, p);
    }
    nextRefs.clear();
    fresh.length = 0;
    for (let j = i; j !== -1; j = now.chain[j]) {
      const ref = items[j];
      nextRefs.add(ref);
      const p = refFirst.get(ref);
      if (p === undefined) fresh.push(j);
      else if (p !== -1) {
        take(j, p);
        refFirst.set(ref, refNext[p]);
      }
    }
    remainder.length = 0;
    for (let p = b; p !== -1; p = was.chain[p])
      if (!nextRefs.has(was.items[p])) remainder.push(p);
    if (remainder.length === fresh.length)
      for (let j = 0; j < fresh.length; j++) take(fresh[j], remainder[j]);
  }

  for (let i = 0; i < n; i++) {
    if (assigned[i]) continue;
    const handle: KeyHandle<K> = Object.freeze({
      key: now.keys[i],
      n: t.next++,
    });
    minted.add(handle);
    out[i] = handle;
  }

  for (let p = 0; p < pn; p++) if (!used[p]) t.destroyed.push(was.handles[p]);

  t.cur = now;
  t.spare = was;
  return t.result;
}
