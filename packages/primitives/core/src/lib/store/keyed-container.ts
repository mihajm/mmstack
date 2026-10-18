import { isDevMode, type WritableSignal } from '@angular/core';
import { type OpSync } from './op-sync';

/**
 * Reserved key holding an element's fractional position inside a keyed container. It lives INSIDE
 * the element (at `[container, elementKey, '~pos']`), so a reorder is a one-field write that never
 * collides with a concurrent edit to the element's data. It stays visible on the materialized
 * element value; do not read, write, or strip it by hand, use the helpers in this file.
 */
export const POS_SEGMENT = '~pos';

// Order-preserving fractional-index digits. The alphabet is ASCII-ascending, so a plain string
// comparison of two positions matches their fractional order with no decoding.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const digitOf = (c: string): number => DIGITS.indexOf(c);

// Repeated inserts into the SAME gap grow a position one digit at a time. Healthy positions stay a
// few characters; a long one signals a hot insertion point that should be rebalanced.
const POS_WARN_LENGTH = 48;
let posWarned = false;
const warnIfLong = (pos: string): string => {
  if (isDevMode() && !posWarned && pos.length >= POS_WARN_LENGTH) {
    posWarned = true;
    console.warn(
      `[@mmstack/primitives] a keyed-container position grew to ${pos.length} characters from ` +
        `repeated inserts into one gap. Call rebalanceContainer(...) to reclaim precision.`,
    );
  }
  return pos;
};

/**
 * A compact position string strictly between `before` and `after`, ordered by plain string
 * comparison. Pass `undefined` for an open end: `posBetween()` seeds the first element,
 * `posBetween(last)` appends, `posBetween(undefined, first)` prepends. Repeated inserts into the
 * same gap grow the string one digit at a time rather than colliding, and the result is never equal
 * to either neighbor. `before` must sort before `after`.
 */
export function posBetween(before?: string, after?: string): string {
  // Neighbors can tie (concurrent inserts into the same gap leave two equal positions, ordered only
  // by key). There is no position strictly between equal bounds, so open the upper end: the new
  // position sorts just after them and stays deterministic instead of looping.
  const upper = before != null && after != null && before >= after ? undefined : after;
  let i = 0;
  let out = '';
  // The upper bound only opens to BASE once we pass `after`'s last constraining digit: an adjacent
  // pair (gap of 1) leaves no room here, so we commit the lower digit and everything deeper is free.
  let upperOpen = upper == null;
  for (;;) {
    const lo = before != null && i < before.length ? digitOf(before[i]) : 0;
    const hi = upperOpen || upper == null ? BASE : i < upper.length ? digitOf(upper[i]) : 0;
    if (hi - lo >= 2) return warnIfLong(out + DIGITS[lo + ((hi - lo) >> 1)]);
    if (hi === lo) {
      // digits equal: no room yet, but `after` still constrains deeper digits, keep following it
      out += DIGITS[lo];
      i++;
      continue;
    }
    // gap of 1: commit the lower digit and open the upper bound (deeper digits only exceed `before`)
    out += DIGITS[lo];
    i++;
    upperOpen = true;
  }
}

/** An element of a keyed container in reading order: its key, its position, and its value. */
export type OrderedEntry<T> = {
  readonly key: string;
  readonly pos: string;
  readonly value: T;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An element's position: its `~pos` string, or `''` when missing or not a string. */
const posOf = (element: unknown): string => {
  const raw = isRecord(element) ? element[POS_SEGMENT] : undefined;
  return typeof raw === 'string' ? raw : '';
};

/** `(pa, ka)` sorts before `(pb, kb)`: by position, ties broken by key (the reading order). */
const precedes = (pa: string, ka: string, pb: string, kb: string): boolean =>
  pa < pb || (pa === pb && ka < kb);

// Reused by every ordering call: the sort buffer and the container its comparator reads. Calls are
// synchronous and never re-enter, so one buffer serves them all.
const keyBuffer: string[] = [];
let sorting: Record<string, unknown> = {};
const byReadingOrder = (a: string, b: string): number => {
  const pa = posOf(sorting[a]);
  const pb = posOf(sorting[b]);
  return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The container's keys in reading order, `exclude` left out, in the shared buffer (no copies). */
function sortedKeys(container: Record<string, unknown>, exclude?: string): string[] {
  keyBuffer.length = 0;
  for (const key in container)
    if (Object.hasOwn(container, key) && key !== exclude) keyBuffer.push(key);
  sorting = container;
  keyBuffer.sort(byReadingOrder);
  sorting = {};
  return keyBuffer;
}

/**
 * A keyed container's elements in reading order. Order is a pure function of the materialized
 * value: elements sort by their `~pos` string, ties broken by key. An element whose `~pos` is
 * missing or not a string is ordered as if its position were the empty string (it sorts first,
 * key breaking the tie), so a peer that dropped the position field still lands somewhere
 * deterministic on every replica.
 */
export function orderedEntries<T>(container: Record<string, T>): OrderedEntry<T>[] {
  return entriesOf(container, (element) => element);
}

function entriesOf<T, E>(
  container: Record<string, E>,
  payloadOf: (element: E) => T,
): OrderedEntry<T>[] {
  const keys = sortedKeys(container);
  const entries = new Array<OrderedEntry<T>>(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const element = container[keys[i]];
    entries[i] = { key: keys[i], pos: posOf(element), value: payloadOf(element) };
  }
  keys.length = 0;
  return entries;
}

/** A store node (or plain writable signal) holding a keyed container: a RECORD keyed by element id. */
export type ContainerNode<T> = WritableSignal<Record<string, T>>;

const devError = (msg: string): void => {
  if (typeof ngDevMode !== 'undefined' && ngDevMode) console.error(`[keyed-container] ${msg}`);
};

declare const ngDevMode: boolean | undefined;

type Neighbours = [before: string | undefined, after: string | undefined];

/** The positions around slot `index` of the reading order, `exclude` left out. */
function neighboursAt(
  container: Record<string, unknown>,
  index: number,
  exclude: string,
): Neighbours {
  const keys = sortedKeys(container, exclude);
  const clamped = Math.max(0, Math.min(index, keys.length));
  const before = clamped > 0 ? posOf(container[keys[clamped - 1]]) || undefined : undefined;
  const after = clamped < keys.length ? posOf(container[keys[clamped]]) || undefined : undefined;
  keys.length = 0;
  return [before, after];
}

/**
 * A drop position named by a neighbour instead of a slot: right after `after`, right before
 * `before`, or the only element of an otherwise empty container. Resolved when the write is
 * applied, against the order the container holds then.
 */
export type Anchor<K = string> = { readonly after: K } | { readonly before: K } | { readonly empty: true };

/**
 * The positions around an anchor in ONE scan, no sort: for `after: k`, `k`'s position and the
 * smallest `(pos, key)` above it; `before: k` mirrors it. `undefined` when the anchor names no
 * element present other than `exclude` (or `empty` finds siblings, which also logs in dev mode).
 */
function resolveAnchor(
  container: Record<string, unknown>,
  anchor: Anchor,
  exclude: string,
  verb: string,
): Neighbours | undefined {
  if ('empty' in anchor) {
    for (const key in container)
      if (Object.hasOwn(container, key) && key !== exclude) {
        devError(`${verb}: an 'empty' anchor needs an otherwise empty container; nothing written`);
        return undefined;
      }
    return [undefined, undefined];
  }
  const after = 'after' in anchor;
  const k = after ? anchor.after : anchor.before;
  if (k === exclude || !Object.hasOwn(container, k)) return undefined;
  const pk = posOf(container[k]);
  let bestKey: string | undefined;
  let bestPos = '';
  for (const key in container) {
    if (!Object.hasOwn(container, key) || key === exclude || key === k) continue;
    const p = posOf(container[key]);
    const beyond = after ? precedes(pk, k, p, key) : precedes(p, key, pk, k);
    if (!beyond) continue;
    const better =
      bestKey === undefined ||
      (after ? precedes(p, key, bestPos, bestKey) : precedes(bestPos, bestKey, p, key));
    if (better) {
      bestKey = key;
      bestPos = p;
    }
  }
  const near = bestKey === undefined ? undefined : bestPos || undefined;
  return after ? [pk || undefined, near] : [near, pk || undefined];
}

/**
 * Insert `value` under `key` at `index` in reading order (default: append). The position is
 * computed from the neighbors at that index, so the element lands where asked without renumbering
 * any sibling. A keyed container is a RECORD, never an array, so this is a per-key write the sync
 * layer diffs on its own. Returns the assigned position. Re-inserting an existing key overwrites it.
 *
 * Pass an {@link Anchor} instead of an index to place the element next to a neighbour as the
 * container stands NOW (an external drop has the same concurrency need as a local move; see
 * {@link moveElement}). An anchor that names no other element present writes nothing and returns
 * `undefined`.
 */
export function insertElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  value: T,
  index?: number,
): string;
export function insertElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  value: T,
  index: Anchor | number | undefined,
): string | undefined;
export function insertElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  value: T,
  index?: number | Anchor,
): string | undefined {
  return insertInto(container, key, value, index, inlineElement);
}

const inlineElement = <T extends object>(value: T, pos: string): T => {
  if (POS_SEGMENT in value) devError(`insert: '${POS_SEGMENT}' is managed, drop it from the value`);
  return { ...value, [POS_SEGMENT]: pos };
};

function insertInto<T, E>(
  container: ContainerNode<E>,
  key: string,
  value: T,
  index: number | Anchor | undefined,
  elementOf: (value: T, pos: string) => E,
): string | undefined {
  const c = container() as Record<string, unknown>;
  const neighbours =
    typeof index === 'object'
      ? resolveAnchor(c, index, key, 'insert')
      : neighboursAt(c, index ?? Number.POSITIVE_INFINITY, key);
  if (!neighbours) return undefined;
  const pos = posBetween(neighbours[0], neighbours[1]);
  container.update((x) => ({ ...x, [key]: elementOf(value, pos) }));
  return pos;
}

/**
 * Move the element at `key` to `index` in reading order. This writes ONLY the element's `~pos`
 * field, so it never conflicts with a concurrent edit to the same element's data (they land on
 * different paths and both survive). Returns the new position, or `undefined` if `key` is absent.
 *
 * Pass an {@link Anchor} instead of an index to place the element next to a neighbour as the
 * container stands NOW (`{ after: 'c' }` stays right after `c` even if peers inserted around it
 * since the drop was decided). An anchor that names no other element present (an absent key, the
 * moved key itself, or `empty` with siblings left) moves nothing, writes nothing and returns
 * `undefined`; the `empty` misuse also logs in dev mode. Resolution is local intent, not a
 * distributed adjacency guarantee: peers in different states may resolve one anchor differently,
 * as they would an index. Neighbours tied on `~pos` leave no room between them, so `after` the
 * first can land after both (an index has the same limit). An anchor is resolved in one pass over
 * the container, without sorting it.
 */
export function moveElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  index: number | Anchor,
): string | undefined {
  const c = container() as Record<string, unknown>;
  if (c[key] == null) return undefined;
  const neighbours =
    typeof index === 'number'
      ? neighboursAt(c, index, key)
      : resolveAnchor(c, index, key, 'move');
  if (!neighbours) return undefined;
  const pos = posBetween(neighbours[0], neighbours[1]);
  container.update((x) => ({ ...x, [key]: { ...x[key], [POS_SEGMENT]: pos } }));
  return pos;
}

/** Remove the element at `key`. Deletes the whole element (a per-key delete the sync layer folds). */
export function removeElement<T>(container: ContainerNode<T>, key: string): void {
  container.update((c) => {
    if (!(key in c)) return c;
    const next = { ...c };
    delete next[key];
    return next;
  });
}

/**
 * Reassign every element's position to a fresh, evenly spaced sequence, as an authority write:
 * each `~pos` set is epoch-bumped so it wins the merge against any concurrent move, while leaving
 * concurrent edits to element DATA untouched (only the `~pos` fields are written). Use this to
 * reclaim precision after many same-gap inserts. Existing reading order is preserved.
 */
export function rebalanceContainer<T extends object>(
  sync: Pick<OpSync, 'override'>,
  container: ContainerNode<T>,
): void {
  const order = orderedEntries(container());
  const positions = evenPositions(order.length);
  sync.override(() => {
    container.update((c) => {
      const next = { ...c };
      order.forEach(({ key }, i) => {
        next[key] = { ...c[key], [POS_SEGMENT]: positions[i] };
      });
      return next;
    });
  });
}

// `n` evenly spaced, order-preserving positions in (0, 1): fraction (i+1)/(n+1) encoded to enough
// base-62 digits that consecutive fractions never collide. Compact, so precision is reclaimed.
function evenPositions(n: number): string[] {
  if (n === 0) return [];
  const digits = Math.floor(Math.log(n + 1) / Math.log(BASE)) + 2;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let f = (i + 1) / (n + 1);
    let s = '';
    for (let k = 0; k < digits; k++) {
      f *= BASE;
      const d = Math.min(BASE - 1, Math.floor(f));
      s += DIGITS[d];
      f -= d;
    }
    out.push(s);
  }
  return out;
}

/**
 * An element of a container in the WRAPPED representation: position beside the payload rather than
 * inside it, so the payload stays a closed record a schema can validate without knowing about
 * `~pos`. A move writes `[container, key, '~pos']` and a field edit writes
 * `[container, key, 'value', field]` — still disjoint one-field paths.
 */
export type ContainerEntry<T> = {
  readonly [POS_SEGMENT]: string;
  readonly value: T;
};

/** `key` derives an element's key from the value, for payloads carrying their own identity field. */
export type KeyedContainerConfig<T> = {
  readonly key?: (value: T) => string;
};

/** The helpers of one container flavour, with keys supplied by the caller. */
export type KeyedContainer<T extends object, E extends object = T> = {
  entries(container: Record<string, E>): OrderedEntry<T>[];
  insert(container: ContainerNode<E>, key: string, value: T, index?: number): string;
  insert(
    container: ContainerNode<E>,
    key: string,
    value: T,
    index: Anchor | number | undefined,
  ): string | undefined;
  move(container: ContainerNode<E>, key: string, index: number | Anchor): string | undefined;
  remove(container: ContainerNode<E>, key: string): void;
  rebalance(sync: Pick<OpSync, 'override'>, container: ContainerNode<E>): void;
};

/** The same helpers where a configured `key` extractor supplies the key, so `insert` takes none. */
export type SelfKeyedContainer<T extends object, E extends object = T> = Omit<
  KeyedContainer<T, E>,
  'insert'
> & {
  insert(container: ContainerNode<E>, value: T, index?: number): string;
  insert(container: ContainerNode<E>, value: T, index: Anchor | number | undefined): string | undefined;
};

/**
 * Binds one container flavour to the whole set of helpers, so every read and write of a container
 * agrees on how its elements are shaped. Pass the container node itself per call: one flavour
 * serves every container of a type. Positions live INSIDE the element; for a payload that must
 * stay a closed record, use {@link wrappedContainer} instead.
 *
 * ```typescript
 * const slots = keyedContainer({ key: (n: Node) => n.id });
 * slots.insert(node, child, 2); // one set at [container, id]
 * slots.move(node, 'child-1', 0); // one set at [container, 'child-1', '~pos']
 * slots.entries(node()); // reading order
 * ```
 *
 * With no extractor, `insert` takes the key: `keyedContainer<Node>()`. A duplicate key OVERWRITES,
 * taking a fresh position at the requested index. An element's identity field is immutable while it
 * is resident — re-keying is a remove plus an insert, never an edit.
 */
export function keyedContainer<T extends object>(config: {
  key: (value: T) => string;
}): SelfKeyedContainer<T>;
export function keyedContainer<T extends object>(config?: { key?: never }): KeyedContainer<T>;
export function keyedContainer<T extends object>(
  config: KeyedContainerConfig<T> = {},
): KeyedContainer<T> | SelfKeyedContainer<T> {
  return helpersFor<T, T>(config.key, inlineElement, (element) => element);
}

/**
 * {@link keyedContainer} storing every element as a {@link ContainerEntry}: the position sits
 * beside the payload rather than inside it, so a schema that closes the payload record still
 * validates. `entries` reads back payloads, never wrappers.
 *
 * ```typescript
 * const slots = wrappedContainer({ key: (n: Node) => n.id });
 * slots.insert(node, child, 2); // one set at [container, id] carrying { '~pos', value }
 * ```
 *
 * A container's representation is fixed when it is created and is never carried on the wire, so
 * every peer of a synced container must agree on it — converting one after the fact is a data
 * migration, not a flag.
 */
export function wrappedContainer<T extends object>(config: {
  key: (value: T) => string;
}): SelfKeyedContainer<T, ContainerEntry<T>>;
export function wrappedContainer<T extends object>(config?: {
  key?: never;
}): KeyedContainer<T, ContainerEntry<T>>;
export function wrappedContainer<T extends object>(
  config: KeyedContainerConfig<T> = {},
): KeyedContainer<T, ContainerEntry<T>> | SelfKeyedContainer<T, ContainerEntry<T>> {
  return helpersFor<T, ContainerEntry<T>>(
    config.key,
    (value, pos) => ({ [POS_SEGMENT]: pos, value }),
    (element) => element.value,
  );
}

function helpersFor<T extends object, E extends object>(
  extract: ((value: T) => string) | undefined,
  elementOf: (value: T, pos: string) => E,
  payloadOf: (element: E) => T,
): KeyedContainer<T, E> & SelfKeyedContainer<T, E> {
  type Index = number | Anchor | undefined;
  const insert = (container: ContainerNode<E>, a: string | T, b?: T | Index, c?: Index) =>
    extract
      ? insertInto(container, extract(a as T), a as T, b as Index, elementOf)
      : insertInto(container, a as string, b as T, c, elementOf);
  return {
    entries: (container) => entriesOf(container, payloadOf),
    insert: insert as KeyedContainer<T, E>['insert'] & SelfKeyedContainer<T, E>['insert'],
    move: (container, key, index) => moveElement(container, key, index),
    remove: (container, key) => removeElement(container, key),
    rebalance: (sync, container) => rebalanceContainer(sync, container),
  };
}
