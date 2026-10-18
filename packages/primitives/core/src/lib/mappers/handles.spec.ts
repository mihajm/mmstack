/**
 * The `handles` model: the continuity laws, written from the prose before the code.
 *
 * Every transition `prev → next` is checked against a declarative encoding of the laws, which
 * partitions the two sides its own way (by item reference, then by key) instead of replaying the
 * implementation's matching:
 * - an item reference that occurs on both sides is a group whose only observable is its
 *   multiplicity: its new occurrences take the group's previous handles in order, the surplus is
 *   created fresh or retired (a reference occurring once on each side is the evidence case);
 * - per key, the occurrences whose reference is on one side only ("fresh objects") match in order
 *   when the two counts are equal (a convention, the immutable-update case), and otherwise every
 *   previous one retires and every new one is fresh;
 * - a fresh handle is the raw key exactly when the key had no previous occurrence and has one new
 *   occurrence, and an opaque `{ key, n }` with an `n` never seen before otherwise;
 * - the destroyed handles are exactly the previous handles that are not in the next table.
 *
 * Not covered (the model abstracts it away): the ORDER in which fresh `n` values are minted (only
 * freshness is asserted); the cost of a transition; impure `keyOf` (the same reference is assumed
 * to always yield the same key); references and keys are compared with `Map` semantics
 * (SameValueZero), so `+0`/`-0` items are one reference. The keyArray integration (entry reuse,
 * `onDestroy`, `index`) is covered by the keyArray specs, not here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { handles, isKeyHandle, type Handle, type HandleTable } from './handles';

type Item = { readonly id: unknown; readonly uid: number };
const keyOf = (item: Item) => item.id;

let uid = 0;
const make = (id: unknown): Item => ({ id, uid: uid++ });
const sameValueZero = (a: unknown, b: unknown) =>
  a === b || (a !== a && b !== b);

const positions = <T>(list: readonly T[]): Map<T, number[]> => {
  const out = new Map<T, number[]>();
  list.forEach((value, i) => {
    const at = out.get(value);
    if (at) at.push(i);
    else out.set(value, [i]);
  });
  return out;
};

/**
 * The named laws that one transition breaks (empty = all hold). `everN` holds every opaque `n`
 * seen so far in the history and is extended with this transition's fresh ones.
 */
function lawViolations<T, K>(
  keyFn: (item: T) => K,
  prevItems: readonly T[],
  prevHandles: readonly Handle<K>[],
  nextItems: readonly T[],
  nextHandles: readonly Handle<K>[],
  destroyed: readonly Handle<K>[],
  everN: Set<number>,
): string[] {
  const out: string[] = [];
  const prevSet = new Set<unknown>(prevHandles);
  const nextSet = new Set<unknown>(nextHandles);
  const isFresh = (h: Handle<K>) => !prevSet.has(h);

  if (
    nextHandles.length !== nextItems.length ||
    nextItems.some((_, i) => !(i in nextHandles))
  )
    out.push('total: one handle per item');
  if (nextSet.size !== nextHandles.length) out.push('(i) uniqueness');

  nextHandles.forEach((h, i) => {
    const key = keyFn(nextItems[i]);
    if (isKeyHandle(h) ? !Object.is(h.key, key) : !Object.is(h, key))
      out.push(`handle names its key at ${i}`);
  });

  const prevByRef = positions(prevItems);
  const nextByRef = positions(nextItems);

  // the multiplicity law (a reference occurring on both sides; (1,1) is the evidence case (ii))
  for (const [ref, at] of nextByRef) {
    const before = prevByRef.get(ref);
    if (!before) continue;
    const kept = Math.min(before.length, at.length);
    for (let j = 0; j < at.length; j++) {
      const h = nextHandles[at[j]];
      if (j < kept) {
        if (!sameValueZero(h, prevHandles[before[j]]))
          out.push(
            before.length === 1 && at.length === 1
              ? '(ii) evidence keeps its handle'
              : 'multiplicity: in-order keep',
          );
      } else if (!isFresh(h)) out.push('multiplicity: growth creates fresh');
    }
    for (let j = kept; j < before.length; j++)
      if (nextSet.has(prevHandles[before[j]]))
        out.push('multiplicity: shrink retires the surplus');
  }

  // per key: the fresh-object remainder, and the raw-key rule
  const prevKeys = positions(prevItems.map(keyFn));
  const nextKeys = positions(nextItems.map(keyFn));
  for (const [key, at] of nextKeys) {
    const before = prevKeys.get(key) ?? [];
    const pf = before.filter((i) => !nextByRef.has(prevItems[i]));
    const nf = at.filter((i) => !prevByRef.has(nextItems[i]));
    if (pf.length === nf.length) {
      nf.forEach((i, j) => {
        if (!sameValueZero(nextHandles[i], prevHandles[pf[j]]))
          out.push('convention: equal counts in order');
      });
    } else {
      for (const i of nf)
        if (!isFresh(nextHandles[i])) out.push('ambiguous: new ones are fresh');
      for (const i of pf)
        if (nextSet.has(prevHandles[i]))
          out.push('ambiguous: previous ones retire');
    }
    for (const i of at) {
      const h = nextHandles[i];
      if (!isFresh(h)) continue;
      const raw =
        at.length === 1 &&
        !isKeyHandle(key) &&
        !before.some((p) => sameValueZero(prevHandles[p], key));
      if (raw !== !isKeyHandle(h))
        out.push(
          '(iv) raw key iff a new sole occurrence of a key that is no handle and never held raw',
        );
    }
  }

  // fresh opaque handles never reuse an `n`
  for (const h of nextHandles) {
    if (isKeyHandle(h) && !Object.isFrozen(h))
      out.push('opaque handles are frozen');
    if (!isKeyHandle(h) || !isFresh(h)) continue;
    if (everN.has(h.n)) out.push('opaque n is never reused');
    everN.add(h.n);
  }

  // (iii) the destroyed handles are exactly the retired ones
  const retired = prevHandles.filter((h) => !nextSet.has(h));
  const destroyedSet = new Set<unknown>(destroyed);
  if (
    destroyedSet.size !== destroyed.length ||
    retired.length !== destroyed.length ||
    retired.some((h) => !destroyedSet.has(h))
  )
    out.push('(iii) destroyed = exactly the retired handles');
  else if (retired.some((h, i) => !sameValueZero(h, destroyed[i])))
    out.push('destroyed in previous order');

  return [...new Set(out)];
}

// ---------------------------------------------------------------- random histories

/** A literal key, or `{ minted: i }`: the i-th opaque handle minted earlier in the history. */
type KeySpec = string | number | { readonly minted: number };

type Edit =
  | { readonly t: 'insert'; readonly key: KeySpec; readonly at: number }
  | { readonly t: 'remove'; readonly at: number }
  | { readonly t: 'move'; readonly from: number; readonly to: number }
  | { readonly t: 'dup'; readonly from: number; readonly to: number }
  | { readonly t: 'replace'; readonly at: number }
  | { readonly t: 'alias'; readonly at: number; readonly from: number };

const KEYS: KeySpec[] = ['a', 'b', 'a#1', 1, NaN];
const nat = fc.nat({ max: 50 });
const keySpec: fc.Arbitrary<KeySpec> = fc.oneof(
  fc.constantFrom(...KEYS),
  fc.record({ minted: nat }),
);
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    t: fc.constant('insert' as const),
    key: keySpec,
    at: nat,
  }),
  fc.record({ t: fc.constant('remove' as const), at: nat }),
  fc.record({ t: fc.constant('move' as const), from: nat, to: nat }),
  fc.record({ t: fc.constant('dup' as const), from: nat, to: nat }),
  fc.record({ t: fc.constant('replace' as const), at: nat }),
  fc.record({ t: fc.constant('alias' as const), at: nat, from: nat }),
);
const history = fc.array(fc.array(edit, { minLength: 1, maxLength: 4 }), {
  maxLength: 10,
});

const resolveKey = (spec: KeySpec, minted: readonly unknown[]): unknown =>
  typeof spec === 'object'
    ? minted.length
      ? minted[spec.minted % minted.length]
      : 'a'
    : spec;

function apply(
  items: readonly Item[],
  e: Edit,
  minted: readonly unknown[] = [],
): Item[] {
  const out = [...items];
  const n = out.length;
  switch (e.t) {
    case 'insert':
      out.splice(e.at % (n + 1), 0, make(resolveKey(e.key, minted)));
      return out;
    case 'remove':
      if (n) out.splice(e.at % n, 1);
      return out;
    case 'move': {
      if (!n) return out;
      const [moved] = out.splice(e.from % n, 1);
      out.splice(e.to % n, 0, moved);
      return out;
    }
    case 'dup':
      if (n) out.splice(e.to % (n + 1), 0, out[e.from % n]);
      return out;
    case 'replace':
      if (n) out[e.at % n] = make(out[e.at % n].id);
      return out;
    case 'alias': {
      if (!n) return out;
      out[e.at % n] = out[e.from % n];
      return out;
    }
  }
}

/** Runs a history through `handles` and returns every law broken, tagged with its step. */
function runHistory(steps: readonly (readonly Edit[])[]): string[] {
  let table: HandleTable<Item, unknown> | undefined;
  let items: Item[] = [];
  const everN = new Set<number>();
  const minted: unknown[] = [];
  const broken: string[] = [];
  steps.forEach((step, s) => {
    const next = step.reduce((acc, e) => apply(acc, e, minted), items);
    const prevItems = table?.items ?? [];
    const prevHandles = table?.handles ?? [];
    const result = handles(table, next, keyOf);
    for (const law of lawViolations(
      keyOf,
      prevItems,
      prevHandles,
      next,
      result.table.handles,
      result.destroyed,
      everN,
    ))
      broken.push(`step ${s}: ${law}`);
    for (const h of result.table.handles)
      if (isKeyHandle(h) && !minted.includes(h)) minted.push(h);
    table = result.table;
    items = next;
  });
  return broken;
}

/** Like `apply`, but never makes a key occur twice: the duplicate-free histories of law (iv). */
function applyUnique(items: readonly Item[], e: Edit): Item[] {
  if (e.t === 'dup') return apply(items, { t: 'replace', at: e.to });
  if (e.t === 'alias') return apply(items, { t: 'replace', at: e.at });
  if (e.t === 'insert' && typeof e.key === 'object') return [...items];
  if (e.t === 'insert' && items.some((item) => sameValueZero(item.id, e.key)))
    return [...items];
  return apply(items, e);
}

const uniqueEdit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({
    t: fc.constant('insert' as const),
    key: fc.constantFrom<KeySpec>('a', 'b', 'c', 'd', 'a#1', 1, 2, NaN),
    at: nat,
  }),
  edit,
);

/** One observed transition, with the counts a consumer sees. */
function observe<T, K>(
  prev: HandleTable<T, K> | undefined,
  items: readonly T[],
  keyFn: (item: T) => K,
) {
  // the table and `destroyed` are reused by the next call: copy what a pin keeps
  const before = new Set<unknown>(prev?.handles ?? []);
  const result = handles(prev, items, keyFn);
  const created = result.table.handles.filter((h) => !before.has(h)).length;
  return {
    table: result.table,
    h: [...result.table.handles],
    destroyed: [...result.destroyed],
    created,
  };
}

describe('handles — the model', () => {
  it('[PIN M1 laws] every transition of a random history with duplicates obeys the laws', () => {
    fc.assert(
      fc.property(history, (steps) => {
        expect(runHistory(steps)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('[PIN M1 laws] repeated primitive items: identical-object groups only', () => {
    const prim = fc.array(
      fc.array(fc.constantFrom('a', 'b', 'a#1'), { maxLength: 6 }),
      {
        maxLength: 10,
      },
    );
    fc.assert(
      fc.property(prim, (states) => {
        let table: HandleTable<string, string> | undefined;
        const everN = new Set<number>();
        for (const next of states) {
          const prevItems = table?.items ?? [];
          const prevHandles = table?.handles ?? [];
          const result = handles(table, next, (v) => v);
          const broken = lawViolations(
            (v: string) => v,
            prevItems,
            prevHandles,
            next,
            result.table.handles,
            result.destroyed,
            everN,
          );
          expect(broken).toEqual([]);
          table = result.table;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('[PIN M1 (iv)] histories that remain duplicate-free: handles are the raw keys', () => {
    const steps = fc.array(
      fc.array(uniqueEdit, { minLength: 1, maxLength: 4 }),
      {
        maxLength: 10,
      },
    );
    fc.assert(
      fc.property(steps, (history) => {
        let table: HandleTable<Item, unknown> | undefined;
        let items: Item[] = [];
        for (const step of history) {
          items = step.reduce(applyUnique, items);
          table = handles(table, items, keyOf).table;
          expect(table.handles).toEqual(items.map(keyOf));
          expect(table.handles.some(isKeyHandle)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('handles — pins', () => {
  const a1 = make('a');
  const a2 = make('a');
  const a3 = make('a');

  it('[PIN M1 K-dup] [a1,a2] → [a2]: a2 keeps its opaque handle, one destroy, zero creates', () => {
    const s0 = observe(undefined, [a1, a2], keyOf);
    const s1 = observe(s0.table, [a2], keyOf);
    expect(isKeyHandle(s0.h[1])).toBe(true);
    expect(s1.h[0]).toBe(s0.h[1]);
    expect(s1.destroyed).toEqual([s0.h[0]]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 unique→dup] [a1] → [a1,a2]: a1 keeps raw `a`, zero destroys, one create', () => {
    const s0 = observe(undefined, [a1], keyOf);
    const s1 = observe(s0.table, [a1, a2], keyOf);
    expect(s0.h).toEqual(['a']);
    expect(s1.h[0]).toBe('a');
    expect(isKeyHandle(s1.h[1])).toBe(true);
    expect(s1.destroyed).toEqual([]);
    expect(s1.created).toBe(1);
  });

  it('[PIN M1 lifetime] [a1,a2] → [a2] → [a2,a3] → [a2]: a2 keeps the same handle throughout', () => {
    const s0 = observe(undefined, [a1, a2], keyOf);
    const s1 = observe(s0.table, [a2], keyOf);
    const s2 = observe(s1.table, [a2, a3], keyOf);
    const s3 = observe(s2.table, [a2], keyOf);
    const h = s0.h[1];
    expect([s1.h[0], s2.h[0], s3.h[0]]).toEqual([h, h, h]);
    expect([s1.created, s2.created, s3.created]).toEqual([0, 1, 0]);
    expect(s3.destroyed).toEqual([s2.h[1]]);
  });

  it('[PIN M1 multiplicity] [x,x] → [x]: one destroy, zero creates, the first occurrence survives', () => {
    const x = make('x');
    const s0 = observe(undefined, [x, x], keyOf);
    const s1 = observe(s0.table, [x], keyOf);
    expect(s1.h).toEqual([s0.h[0]]);
    expect(s1.destroyed).toEqual([s0.h[1]]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 multiplicity] [x] → [x,x]: zero destroys, one create (the inverse)', () => {
    const x = make('x');
    const s0 = observe(undefined, [x], keyOf);
    const s1 = observe(s0.table, [x, x], keyOf);
    expect(s1.h[0]).toBe(s0.h[0]);
    expect(s1.destroyed).toEqual([]);
    expect(s1.created).toBe(1);
  });

  it('[PIN M1 multiplicity] [x,x] → [x,x]: zero ops, the handles keep their order', () => {
    const x = make('x');
    const s0 = observe(undefined, [x, x], keyOf);
    const s1 = observe(s0.table, [x, x], keyOf);
    expect(s1.h).toEqual(s0.h);
    expect(s1.destroyed).toEqual([]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 multiplicity] [x,x,x] → [x]: two destroys', () => {
    const x = make('x');
    const s0 = observe(undefined, [x, x, x], keyOf);
    const s1 = observe(s0.table, [x], keyOf);
    expect(s1.h).toEqual([s0.h[0]]);
    expect(s1.destroyed).toEqual([s0.h[1], s0.h[2]]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 multiplicity] [x,x,y] → [y,x,x]: the x occurrences never permute among themselves', () => {
    const x = make('x');
    const y = make('y');
    const s0 = observe(undefined, [x, x, y], keyOf);
    const s1 = observe(s0.table, [y, x, x], keyOf);
    expect(s1.h).toEqual([s0.h[2], s0.h[0], s0.h[1]]);
    expect(s1.destroyed).toEqual([]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 ambiguous shrink] [a1,a2] → [x] (fresh, same key): two destroys, one create', () => {
    const s0 = observe(undefined, [a1, a2], keyOf);
    const s1 = observe(s0.table, [make('a')], keyOf);
    expect(s1.destroyed).toEqual(s0.h);
    expect(s1.created).toBe(1);
    // born duplicated, so raw `a` was never held: the sole new occurrence gets it back
    expect(s1.h[0]).toBe('a');
  });

  it('[PIN M1 convention] [a1,a2] → [a1′,a2′] (fresh, equal count): in order, zero destroys', () => {
    const s0 = observe(undefined, [a1, a2], keyOf);
    const s1 = observe(s0.table, [make('a'), make('a')], keyOf);
    expect(s1.h).toEqual(s0.h);
    expect(s1.destroyed).toEqual([]);
    expect(s1.created).toBe(0);
  });

  it('[PIN M1 ambiguous growth] [a1,a2] → [x,y,z] (fresh, same key): two destroys, three creates', () => {
    const s0 = observe(undefined, [a1, a2], keyOf);
    const s1 = observe(s0.table, [make('a'), make('a'), make('a')], keyOf);
    expect(s1.destroyed).toEqual(s0.h);
    expect(s1.created).toBe(3);
  });

  it('[PIN M1 U-D-U] [a1] → [a1,a2] → [a2] → [a2′]: a2 keeps its opaque handle through the replacement', () => {
    const s0 = observe(undefined, [a1], keyOf);
    const s1 = observe(s0.table, [a1, a2], keyOf);
    const s2 = observe(s1.table, [a2], keyOf);
    const s3 = observe(s2.table, [make('a')], keyOf);
    expect(s2.h).toEqual([s1.h[1]]);
    expect(s3.h).toEqual([s1.h[1]]);
    expect([s1.created, s2.created, s3.created]).toEqual([1, 0, 0]);
    expect([s1.destroyed, s2.destroyed, s3.destroyed]).toEqual([[], ['a'], []]);
  });

  it('[PIN M1 U-D-U] [a1] → [a1,a2] → [a1] → [a1′]: a1 keeps raw `a` throughout', () => {
    const s0 = observe(undefined, [a1], keyOf);
    const s1 = observe(s0.table, [a1, a2], keyOf);
    const s2 = observe(s1.table, [a1], keyOf);
    const s3 = observe(s2.table, [make('a')], keyOf);
    expect([s1.h[0], s2.h[0], s3.h[0]]).toEqual(['a', 'a', 'a']);
    expect(s2.destroyed).toEqual([s1.h[1]]);
    expect(s3.destroyed).toEqual([]);
  });

  it('[PIN M1 U-D-U ambiguity control] [a1] → [a1,a2] → [a2′]: both retire, one fresh', () => {
    const s0 = observe(undefined, [a1], keyOf);
    const s1 = observe(s0.table, [a1, a2], keyOf);
    const s2 = observe(s1.table, [make('a')], keyOf);
    expect(s2.destroyed).toEqual(s1.h);
    expect(s2.created).toBe(1);
    expect(isKeyHandle(s2.h[0])).toBe(true);
  });

  it('[PIN M1 no collision] a generated handle never equals a user key `a#1`', () => {
    const user = make('a#1');
    const s0 = observe(undefined, [a1, a2, user], keyOf);
    expect(s0.h[2]).toBe('a#1');
    expect(new Set(s0.h).size).toBe(3);
    expect(s0.h.slice(0, 2).every(isKeyHandle)).toBe(true);
    expect(s0.h.slice(0, 2).every((h) => h !== 'a#1')).toBe(true);
    expect(isKeyHandle({ key: 'a', n: 1 })).toBe(false);
  });

  it('[PIN M1 n] an opaque n is never reused after its handle retires', () => {
    let table = observe(undefined, [a1, a2], keyOf).table;
    const seen = new Set<number>();
    for (let round = 0; round < 5; round++) {
      table = observe(table, [make('a'), make('a'), make('a')], keyOf).table;
      for (const h of table.handles) {
        if (!isKeyHandle(h)) continue;
        expect(seen.has(h.n)).toBe(false);
        seen.add(h.n);
      }
      table = observe(table, [], keyOf).table;
    }
  });
});

describe('handles — review pins', () => {
  it('[PIN M1 snapshot] the table never aliases the caller array: reversing it in place keeps the evidence', () => {
    const a1 = make('a');
    const a2 = make('a');
    const input = [a1, a2];
    const s0 = observe(undefined, input, keyOf);
    input.reverse();
    const s1 = observe(s0.table, input, keyOf);
    expect(s1.h).toEqual([s0.h[1], s0.h[0]]);
    expect(s1.destroyed).toEqual([]);
  });

  it('[PIN M1 namespace] a key that is a minted handle is never issued raw: [a1,a2] → [a1,a2,z], key(z) = h1', () => {
    const a1 = make('a');
    const a2 = make('a');
    const s0 = observe(undefined, [a1, a2], keyOf);
    const z = make(s0.h[0]);
    const s1 = observe(s0.table, [a1, a2, z], keyOf);
    expect(new Set(s1.h).size).toBe(3);
    expect(s1.h.slice(0, 2)).toEqual(s0.h);
    expect(isKeyHandle(s1.h[2])).toBe(true);
    expect((s1.h[2] as { key: unknown }).key).toBe(s0.h[0]);
  });

  it('[PIN M1 frozen] every opaque handle is frozen', () => {
    const s0 = observe(undefined, [make('a'), make('a')], keyOf);
    expect(s0.h.every((h) => isKeyHandle(h) && Object.isFrozen(h))).toBe(true);
  });

  it('[PIN M1 destroyed order] `destroyed` lists retired handles in the previous order', () => {
    const s0 = observe(undefined, [make('a'), make('a'), make('b')], keyOf);
    const s1 = observe(s0.table, [], keyOf);
    expect(s1.destroyed).toEqual(s0.h);
  });
});

describe('handles — buffers', () => {
  it('[PIN M1 fast path] identical items and keys return the same table, unswapped, with nothing destroyed', () => {
    const items = [make('a'), make('a'), make('b')];
    const r0 = handles(undefined, items, keyOf);
    const table = r0.table;
    const handlesArray = table.handles;
    const r1 = handles(table, [...items], keyOf);
    expect(r1.table).toBe(table);
    expect(r1.table.handles).toBe(handlesArray);
    expect(r1.destroyed).toEqual([]);
  });

  it('[PIN M1 fast path] same items but a different key is not the fast path', () => {
    const x = make('a');
    const r0 = handles(undefined, [x], keyOf);
    expect(r0.table.handles).toEqual(['a']);
    const r1 = handles(r0.table, [x], () => 'z');
    expect(r1.table.handles).toEqual(['z']);
    expect(r1.destroyed).toEqual(['a']);
  });

  it('[PIN M1 double buffer] two handle buffers alternate; the previous one stays intact for one call', () => {
    const r1 = handles(undefined, [make('a')], keyOf);
    const first = r1.table.handles;
    const r2 = handles(r1.table, [make('b')], keyOf);
    const second = r2.table.handles;
    expect(second).not.toBe(first);
    expect(first).toEqual(['a']); // still readable after the next call
    const r3 = handles(r2.table, [make('c')], keyOf);
    expect(r3.table.handles).toBe(first);
    expect(r3.table.handles).toEqual(['c']);
  });

  it('[PIN M1 no maps at steady state] a warmed table creates no Map or Set per call, duplicates included', () => {
    const x = make('a');
    const states = [
      [x, make('a'), make('b')],
      [make('b'), x, make('a'), make('a')],
      [x, x, make('c')],
      [make('c'), x],
    ];
    let table: HandleTable<Item, unknown> | undefined;
    for (const s of [...states, ...states])
      table = handles(table, s, keyOf).table;
    const OrigMap = globalThis.Map;
    const OrigSet = globalThis.Set;
    let made = 0;
    globalThis.Map = class extends OrigMap<unknown, unknown> {
      constructor(entries?: readonly (readonly [unknown, unknown])[] | null) {
        super(entries);
        made++;
      }
    } as MapConstructor;
    globalThis.Set = class extends OrigSet<unknown> {
      constructor(values?: readonly unknown[] | null) {
        super(values);
        made++;
      }
    } as SetConstructor;
    try {
      for (const s of states) table = handles(table, s, keyOf).table;
    } finally {
      globalThis.Map = OrigMap;
      globalThis.Set = OrigSet;
    }
    expect(made).toBe(0);
  });
});

describe('handles — raw re-issue', () => {
  it('[PIN M1 raw re-issue] [a, a] → [a′, b]: a key born duplicated never held raw, so `a′` gets raw `a`', () => {
    const s0 = observe(undefined, [make('a'), make('a')], keyOf);
    const s1 = observe(s0.table, [make('a'), make('b')], keyOf);
    expect(s1.h).toEqual(['a', 'b']);
    expect(s1.created).toBe(2); // one for a′, one for b
    expect(s1.destroyed).toEqual(s0.h);
  });

  it('[PIN M1 raw re-issue] [a] → [a, a2] → [a3]: raw `a` was held, so `a3` gets an opaque handle', () => {
    const s0 = observe(undefined, [make('a')], keyOf);
    const s1 = observe(s0.table, [s0.table.items[0], make('a')], keyOf);
    const s2 = observe(s1.table, [make('a')], keyOf);
    expect(isKeyHandle(s2.h[0])).toBe(true);
    expect(s2.destroyed).toEqual(['a', s1.h[1]]);
  });
});
