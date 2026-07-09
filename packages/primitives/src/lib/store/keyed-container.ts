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

/**
 * A keyed container's elements in reading order. Order is a pure function of the materialized
 * value: elements sort by their `~pos` string, ties broken by key. An element whose `~pos` is
 * missing or not a string is ordered as if its position were the empty string (it sorts first,
 * key breaking the tie), so a peer that dropped the position field still lands somewhere
 * deterministic on every replica.
 */
export function orderedEntries<T>(container: Record<string, T>): OrderedEntry<T>[] {
  const entries: OrderedEntry<T>[] = [];
  for (const key of Object.keys(container)) {
    const value = container[key];
    const raw = isRecord(value) ? value[POS_SEGMENT] : undefined;
    entries.push({ key, pos: typeof raw === 'string' ? raw : '', value });
  }
  entries.sort((a, b) =>
    a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  return entries;
}

/** A store node (or plain writable signal) holding a keyed container: a RECORD keyed by element id. */
export type ContainerNode<T> = WritableSignal<Record<string, T>>;

const devError = (msg: string): void => {
  if (typeof ngDevMode !== 'undefined' && ngDevMode) console.error(`[keyed-container] ${msg}`);
};

declare const ngDevMode: boolean | undefined;

const neighborPositions = (
  entries: readonly OrderedEntry<unknown>[],
  index: number,
): [string | undefined, string | undefined] => {
  const clamped = Math.max(0, Math.min(index, entries.length));
  return [entries[clamped - 1]?.pos || undefined, entries[clamped]?.pos || undefined];
};

/**
 * Insert `value` under `key` at `index` in reading order (default: append). The position is
 * computed from the neighbors at that index, so the element lands where asked without renumbering
 * any sibling. A keyed container is a RECORD, never an array, so this is a per-key write the sync
 * layer diffs on its own. Returns the assigned position. Re-inserting an existing key overwrites it.
 */
export function insertElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  value: T,
  index?: number,
): string {
  if (POS_SEGMENT in value) devError(`insertElement: '${POS_SEGMENT}' is managed, drop it from the value`);
  const entries = orderedEntries(container()).filter((e) => e.key !== key);
  const [before, after] = neighborPositions(entries, index ?? entries.length);
  const pos = posBetween(before, after);
  container.update((c) => ({ ...c, [key]: { ...value, [POS_SEGMENT]: pos } }));
  return pos;
}

/**
 * Move the element at `key` to `index` in reading order. This writes ONLY the element's `~pos`
 * field, so it never conflicts with a concurrent edit to the same element's data (they land on
 * different paths and both survive). Returns the new position, or `undefined` if `key` is absent.
 */
export function moveElement<T extends object>(
  container: ContainerNode<T>,
  key: string,
  index: number,
): string | undefined {
  const current = container()[key];
  if (current == null) return undefined;
  const entries = orderedEntries(container()).filter((e) => e.key !== key);
  const [before, after] = neighborPositions(entries, index);
  const pos = posBetween(before, after);
  container.update((c) => ({ ...c, [key]: { ...c[key], [POS_SEGMENT]: pos } }));
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
