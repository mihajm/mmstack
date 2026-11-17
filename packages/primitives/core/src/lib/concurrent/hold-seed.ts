import { untracked } from '@angular/core';
import { recordTargetOf } from './active-transaction';

/** @internal A known pre-hold value; `seq` orders writes globally, the lowest is the oldest. */
export type HoldSeed = {
  readonly found: true;
  readonly value: unknown;
  readonly seq: number;
};

type HoldParent = object;

/** Every entry a reader can still consult, per recorded signal, in record order. */
const registry = new Map<
  object,
  { readonly seq: number; readonly pre: unknown }[]
>();
let entries = 0;
let seq = 0;
/** Scopes whose own hold count is above 0. */
const holding = new Set<object>();
/**
 * Each scope's own hold intervals that can still be part of a current stretch: `[start, end]` on
 * the same counter as the entries, `end` absent while open. Every begin and end takes its own
 * tick, so two holds connect only when they overlap.
 */
const intervals = new Map<object, [number, number | undefined][]>();
const redirects = new WeakMap<object, () => object>();
const parents = new WeakMap<object, HoldParent>();

/** The scope a hold on `scope` lands on (a forwarding scope's current target). */
function resolve(scope: object): object {
  const seen = new Set<object>();
  for (let next = redirects.get(scope); next && !seen.has(scope);) {
    seen.add(scope);
    scope = next();
    next = redirects.get(scope);
  }
  return scope;
}

function own(scope: object): [number, number | undefined][] {
  let list = intervals.get(scope);
  if (!list) intervals.set(scope, (list = []));
  return list;
}

/**
 * Drop what no reader can consult any more. A reader in scope `X` reads only entries after
 * `heldSince(X)`, and `heldSince(X)` equals that of the nearest scope in its chain that has
 * intervals, so the lowest `heldSince` over the scopes with intervals bounds every reader. Entries
 * at or below it are dead, and so is a closed interval ending at or below it: a stretch that
 * contains now starts at or after that bound and only holds intervals ending after its start.
 */
function prune(): void {
  if (holding.size === 0) {
    registry.clear();
    intervals.clear();
    entries = 0;
    return;
  }
  let bound = Infinity;
  for (const scope of intervals.keys()) {
    const since = heldSince(scope);
    if (since !== undefined && since < bound) bound = since;
  }
  if (bound === Infinity) return;
  for (const [scope, list] of intervals) {
    const live = list.filter(([, end]) => end === undefined || end > bound);
    if (live.length) intervals.set(scope, live);
    else intervals.delete(scope);
  }
  for (const [sig, list] of registry) {
    let dead = 0;
    while (dead < list.length && list[dead].seq <= bound) dead++;
    if (!dead) continue;
    entries -= dead;
    if (dead === list.length) registry.delete(sig);
    else list.splice(0, dead);
  }
}

/** @internal A forwarding scope: its hold lands on, and is looked up from, `to()`. */
export function redirectHoldSeeds(from: object, to: () => object): void {
  redirects.set(from, to);
}

/** @internal `scope` was created inside `parent`: a hold on the parent also holds it. */
export function inheritHoldSeeds(scope: object, parent: HoldParent): void {
  parents.set(scope, parent);
}

/** @internal The scope's own hold count went from 0 to 1. */
export function beginOwnHold(scope: object): void {
  holding.add(scope);
  own(scope).push([++seq, undefined]);
  prune();
}

/**
 * @internal The scope's own hold count went back to 0. Prunes what no reader can consult; when
 * nothing holds at all, forgets everything.
 */
export function endOwnHold(scope: object): void {
  const open = intervals.get(scope)?.find((i) => i[1] === undefined);
  if (open) open[1] = ++seq;
  holding.delete(scope);
  prune();
}

/** @internal Note a recorded entry; kept only while some scope holds. */
export function recordHoldEntry(sig: object, pre: unknown): void {
  if (holding.size === 0) return;
  let list = registry.get(sig);
  if (!list) registry.set(sig, (list = []));
  list.push({ seq: ++seq, pre });
  entries++;
}

/** @internal How many entries the registry keeps (0 once no scope holds). */
export function holdRegistrySize(): number {
  return entries;
}

/** @internal How many own-hold intervals are kept across all scopes. */
export function holdIntervalCount(): number {
  let n = 0;
  for (const list of intervals.values()) n += list.length;
  return n;
}

/**
 * @internal When `holding()` last became true for `scope`, own or inherited: the start of the
 * stretch, in record order, covered without a gap by the own holds of the scope and the scopes
 * it was created inside. `undefined` when none of them holds now.
 */
export function heldSince(scope: object): number | undefined {
  const all: [number, number | undefined][] = [];
  const seen = new Set<object>();
  for (let s: object | undefined = resolve(scope); s && !seen.has(s);) {
    seen.add(s);
    const list = intervals.get(s);
    if (list) all.push(...list);
    const parent = parents.get(s);
    s = parent ? resolve(parent) : undefined;
  }
  let since: number | undefined;
  for (const [start, end] of all)
    if (end === undefined && (since === undefined || start < since))
      since = start;
  if (since === undefined) return undefined;
  for (let moved = true; moved;) {
    moved = false;
    for (const [start, end] of all)
      if (end !== undefined && end > since && start < since) {
        since = start;
        moved = true;
      }
  }
  return since;
}

/**
 * @internal The pre-hold value of `sig` for a reader in `scope`: the `pre` of the first entry for
 * it recorded since `heldSince(scope)`, or `undefined` (the live value applies).
 */
export function preHoldValueOf(
  scope: object,
  sig: object,
): HoldSeed | undefined {
  return untracked(() => {
    const since = heldSince(scope);
    if (since === undefined) return undefined;
    const e = registry.get(recordTargetOf(sig))?.find((x) => x.seq > since);
    return e && { found: true, value: e.pre, seq: e.seq };
  });
}
