/**
 * mapArray, the keyed mapper: reuse parity with keyArray (the oracle, replayed over the same
 * histories), item freshness, row consistency, keyed survival and `reorders`.
 */
import { computed, signal, type Signal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isKeyHandle, type Handle } from './handles';
import { keyArray } from './key-array';
import type { Permutation } from './survivor-permutation';
import { mapArray } from './map-array';

// ---------------------------------------------------------------- histories
// Copied verbatim from key-array.survivors.spec.ts (`stepOf`, duplicate-free) and handles.spec.ts
// (`edit`, `history`, `apply`, duplicates included); neither file exports them.

type SurvivorItem = { readonly id: string | number; readonly tag: string };
const survivorItem = (id: string | number, tag: string): SurvivorItem => ({
  id,
  tag,
});

const stepOf = (ordinal: boolean) =>
  fc.record({
    ids: fc.uniqueArray(
      fc.constantFrom<string | number>(
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'a#1',
        ...(ordinal ? [] : [1, 2, NaN]),
      ),
      { maxLength: 7 },
    ),
    fresh: fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
  });

type Item = { readonly id: unknown; readonly uid: number };
let uid = 0;
const make = (id: unknown): Item => ({ id, uid: uid++ });

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

// ---------------------------------------------------------------- harness

const sameValueZero = (a: unknown, b: unknown) =>
  a === b || (a !== a && b !== b);

type Law = 'parity' | 'fresh';

type Entry<T> = {
  readonly uid: number;
  readonly handle: unknown;
  readonly index: Signal<number>;
  readonly item?: Signal<T>;
};

/**
 * The oracle `keyArray(…, { handles: true, order: true })` and `mapArray` over one source, each
 * logging its `mapFn` calls, `onDestroy` calls and `onDuplicates` calls in the order they happen.
 */
function pair<T>(keyOf?: (item: T) => unknown) {
  const source = signal<T[]>([]);
  const logOf = () => ({ uid: 0, events: [] as unknown[] });
  const o = logOf();
  const m = logOf();
  let wrongKeys = 0;
  const oracle = keyArray(
    source,
    (_item, index, handle): Entry<T> => {
      const e = { uid: o.uid++, handle, index };
      o.events.push(['create', e.uid, handle, index()]);
      return e;
    },
    {
      key: keyOf,
      handles: true,
      order: true,
      onDestroy: (e) => o.events.push(['destroy', e.uid]),
      onDuplicates: (keys) => o.events.push(['duplicates', [...keys]]),
    },
  );
  const subject = mapArray(
    source,
    (item, index, key, handle): Entry<T> => {
      const e = { uid: m.uid++, handle, index, item };
      if (!sameValueZero(key, keyOf ? keyOf(item()) : item())) wrongKeys++;
      m.events.push(['create', e.uid, handle, index()]);
      return e;
    },
    {
      key: keyOf,
      onDestroy: (e) => m.events.push(['destroy', e.uid]),
      onDuplicates: (keys) => m.events.push(['duplicates', [...keys]]),
    },
  );
  const view = (
    list: Signal<Entry<T>[]> & {
      reorders: Signal<Permutation<Handle<unknown>> | null>;
    },
    log: { events: unknown[] },
    readReorders: boolean,
  ) => {
    const rows = list();
    return {
      uids: rows.map((e) => e.uid),
      index: rows.map((e) => e.index()),
      handles: rows.map((e) => [e.handle, isKeyHandle(e.handle)]),
      events: log.events.splice(0),
      reorders: readReorders ? list.reorders() : 'unread',
    };
  };
  return {
    source,
    oracle,
    subject,
    /**
     * Reads both (the oracle first) and asserts the law under test: `parity` (MA1) or `fresh`
     * (MA2). Returns the oracle's rows.
     */
    step(items: T[], readReorders: boolean, law: Law) {
      source.set(items);
      const want = view(oracle, o, readReorders);
      const got = view(subject, m, readReorders);
      if (law === 'parity') {
        expect(got).toEqual(want);
        expect(wrongKeys).toBe(0);
      } else {
        const rows = subject();
        const now = source();
        expect(rows).toHaveLength(now.length);
        for (let i = 0; i < rows.length; i++) {
          expect(Object.is(rows[i].item?.(), now[i])).toBe(true);
          expect(rows[i].index()).toBe(i);
        }
      }
      return oracle();
    },
  };
}

const reads = fc.array(fc.boolean(), { minLength: 12, maxLength: 12 });

/** Replays a duplicate-free survivors history (ids, fresh flags) through both. */
function replaySurvivors(
  steps: readonly { ids: (string | number)[]; fresh: boolean[] }[],
  read: readonly boolean[],
  keyed: boolean,
  law: Law,
) {
  const t = pair<SurvivorItem>(keyed ? (v) => v.id : undefined);
  let last = new Map<string | number, SurvivorItem>();
  steps.forEach(({ ids, fresh }, s) => {
    const items = ids.map(
      (id, i) => (!fresh[i] && last.get(id)) || survivorItem(id, `${i}`),
    );
    last = new Map(items.map((it) => [it.id, it]));
    t.step(items, read[s], law);
  });
}

/** Replays a duplicate-including edit history through both. */
function replayEdits(
  steps: readonly (readonly Edit[])[],
  read: readonly boolean[],
  keyed: boolean,
  law: Law,
) {
  const t = pair<Item>(keyed ? (v) => v.id : undefined);
  const minted: unknown[] = [];
  let items: Item[] = [];
  steps.forEach((step, s) => {
    items = step.reduce((acc, e) => apply(acc, e, minted), items);
    for (const e of t.step(items, read[s], law))
      if (isKeyHandle(e.handle) && !minted.includes(e.handle))
        minted.push(e.handle);
  });
}

describe('mapArray — MA1 reuse parity with keyArray (oracle replay)', () => {
  for (const keyed of [true, false]) {
    const mode = keyed ? 'key: id' : 'no key';
    for (const ordinal of [false, true]) {
      it(`[PIN MA1] survivors histories (${mode}, ${ordinal ? 'string ids' : 'string, number and NaN ids'}): same creates, destroys, duplicates, handles, index values and reorders`, () => {
        fc.assert(
          fc.property(
            fc.array(stepOf(ordinal), { maxLength: 12 }),
            reads,
            (steps, read) => replaySurvivors(steps, read, keyed, 'parity'),
          ),
          { numRuns: 300 },
        );
      });
    }

    it(`[PIN MA1] edit histories with duplicates (${mode}): same creates, destroys, duplicates, handles, index values and reorders`, () => {
      fc.assert(
        fc.property(history, reads, (steps, read) =>
          replayEdits(steps, read, keyed, 'parity'),
        ),
        { numRuns: 300 },
      );
    });
  }
});

describe('mapArray — MA2 item freshness', () => {
  for (const keyed of [true, false]) {
    const mode = keyed ? 'key: id' : 'no key';
    it(`[PIN MA2] after the list is read, rows()[i].item() is source()[i] and index() is i: survivors histories (${mode})`, () => {
      fc.assert(
        fc.property(
          fc.array(stepOf(false), { maxLength: 12 }),
          reads,
          (steps, read) => replaySurvivors(steps, read, keyed, 'fresh'),
        ),
        { numRuns: 300 },
      );
    });

    it(`[PIN MA2] the same over edit histories with duplicates (${mode})`, () => {
      fc.assert(
        fc.property(history, reads, (steps, read) =>
          replayEdits(steps, read, keyed, 'fresh'),
        ),
        { numRuns: 300 },
      );
    });
  }
});

// ---------------------------------------------------------------- pins

type User = { readonly id: string; readonly name: string };
const user = (id: string, name = id): User => ({ id, name });

describe('mapArray — MA3 row consistency (K6)', () => {
  it('[PIN MA3 prepend] a row read before the list is stale but consistent: [a, 0], then [a, 1]', () => {
    const [a, b, x] = [user('a'), user('b'), user('x')];
    const source = signal([a, b]);
    const list = mapArray(source, (item, index) => ({
      pair: computed(() => [item(), index()] as const),
    }));
    const row = list()[0];
    expect(row.pair()).toEqual([a, 0]);
    source.set([x, a, b]);
    expect(row.pair()).toEqual([a, 0]);
    expect(row.pair()[0]).toBe(a);
    list();
    expect(row.pair()).toEqual([a, 1]);
    expect(row.pair()[0]).toBe(a);
  });

  it('[PIN MA3 key] an immutable update [a] → [a′] (same id): [a, 0] before the list read, [a′, 0] after', () => {
    const a = user('a', 'old');
    const a2 = user('a', 'new');
    const source = signal([a]);
    const list = mapArray(
      source,
      (item, index) => ({
        pair: computed(() => [item(), index()] as const),
      }),
      { key: (u) => u.id },
    );
    const row = list()[0];
    expect(row.pair()[0]).toBe(a);
    source.set([a2]);
    expect(row.pair()[0]).toBe(a);
    expect(row.pair()[1]).toBe(0);
    expect(list()[0]).toBe(row);
    expect(row.pair()[0]).toBe(a2);
    expect(row.pair()[1]).toBe(0);
  });

  it('[PIN MA3 contrast] keyArray with `computed(() => source()[index()])`: a row read before the list after a prepend reports the new item at the old index', () => {
    const [a, b, x] = [user('a'), user('b'), user('x')];
    const source = signal([a, b]);
    const list = keyArray(source, (_v, index) => ({
      current: computed(() => source()[index()]),
    }));
    const row = list()[0];
    expect(row.current()).toBe(a);
    source.set([x, a, b]);
    // the K6 mismatch: the new source through the old index
    expect(row.current()).toBe(x);
    list();
    expect(row.current()).toBe(a);
  });
});

describe('mapArray — MA4 keyed survival (K4)', () => {
  it('[PIN MA4] key: u => u.id, immutable update of one row: same entry, new item(), same index(), no onDestroy, no mapFn call', () => {
    const [a, b, c] = [user('a'), user('b'), user('c')];
    const source = signal([a, b, c]);
    let calls = 0;
    const destroyed: unknown[] = [];
    const list = mapArray(
      source,
      (item, index) => {
        calls++;
        return { item, index };
      },
      { key: (u) => u.id, onDestroy: (e) => destroyed.push(e) },
    );
    const before = list();
    const b2 = { ...b, name: 'renamed' };
    source.set([a, b2, c]);
    const after = list();
    expect(after).toEqual(before);
    after.forEach((e, i) => expect(e).toBe(before[i]));
    expect(after[1].item()).toBe(b2);
    expect(after[1].index()).toBe(1);
    expect(after[0].item()).toBe(a);
    expect(after[2].item()).toBe(c);
    expect(destroyed).toEqual([]);
    expect(calls).toBe(3);
  });

  it('[PIN MA4 middle] an immutable update that also moves (middle path) still follows the new object', () => {
    const [a, b, c, d] = [user('a'), user('b'), user('c'), user('d')];
    const source = signal([a, b, c, d]);
    const list = mapArray(source, (item, index) => ({ item, index }), {
      key: (u) => u.id,
    });
    const [ea, eb, ec, ed] = list();
    const c2 = user('c', 'C');
    source.set([a, c2, b, d]);
    expect(list()).toEqual([ea, ec, eb, ed]);
    expect(ec.item()).toBe(c2);
    expect(ec.index()).toBe(1);
    expect(eb.item()).toBe(b);
  });

  it('[PIN MA4 suffix] an immutable update in the shifted suffix follows the new object', () => {
    const [a, b] = [user('a'), user('b')];
    const source = signal([a, b]);
    const list = mapArray(source, (item, index) => ({ item, index }), {
      key: (u) => u.id,
    });
    const [ea, eb] = list();
    const b2 = user('b', 'B');
    source.set([user('x'), a, b2]);
    expect(list().slice(1)).toEqual([ea, eb]);
    expect(eb.item()).toBe(b2);
    expect(eb.index()).toBe(2);
  });
});

describe('mapArray — MA5 reorders', () => {
  const keyed = (initial: User[]) => {
    const source = signal(initial);
    const list = mapArray(
      source,
      (item, index, _key, handle) => ({ item, index, handle }),
      // annotated: an inline `(u) => u.id` would not infer K here (see map-array.types.spec.ts)
      { key: (u: User) => u.id },
    );
    return { source, list };
  };

  it('[PIN MA5] always present, read-only, first read null', () => {
    const t = keyed([user('a')]);
    expect('reorders' in t.list).toBe(true);
    expect('set' in t.list.reorders).toBe(false);
    expect(t.list.reorders()).toBeNull();
  });

  it('[PIN MA5 rotate] [a,b,c] → [c,a,b] after a baseline read names the survivors by handle', () => {
    const [a, b, c] = [user('a'), user('b'), user('c')];
    const t = keyed([a, b, c]);
    expect(t.list.reorders()).toBeNull();
    t.source.set([c, a, b]);
    expect(t.list.reorders()).toEqual({
      before: ['a', 'b', 'c'],
      after: ['c', 'a', 'b'],
    });
  });

  it('[PIN MA5 prepend] a prepend is not a reorder, while every index bumps', () => {
    const [a, b] = [user('a'), user('b')];
    const t = keyed([a, b]);
    expect(t.list.reorders()).toBeNull();
    const [ea, eb] = t.list();
    t.source.set([user('x'), a, b]);
    expect(t.list.reorders()).toBeNull();
    expect([ea.index(), eb.index()]).toEqual([1, 2]);
  });

  it('[PIN MA5 property] non-null iff a survivor changed rank, named by the handle mapFn received', () => {
    // the order spec's oracle shape: survivors read off entry identity, not off the handles
    type Row = { readonly handle: unknown };
    const states = fc.array(
      fc.array(
        fc.record({
          id: fc.constantFrom('a', 'b', 'c', 'd'),
          reuse: fc.boolean(),
        }),
        { maxLength: 6 },
      ),
      { minLength: 1, maxLength: 10 },
    );
    fc.assert(
      fc.property(states, (history) => {
        const pool = new Map<string, User>();
        let n = 0;
        const t = keyed([]);
        expect(t.list.reorders()).toBeNull();
        let prev: Row[] = t.list();
        for (const state of history) {
          const items = state.map(({ id, reuse }) => {
            const old = pool.get(id);
            const next = reuse && old ? old : user(id, `${n++}`);
            pool.set(id, next);
            return next;
          });
          t.source.set(items);
          const next: Row[] = t.list();
          const inNext = new Set(next);
          const inPrev = new Set(prev);
          const before = prev.filter((e) => inNext.has(e));
          const after = next.filter((e) => inPrev.has(e));
          const moved = before.some((e, i) => e !== after[i]);
          const got = t.list.reorders();
          if (!moved) expect(got).toBeNull();
          else
            expect(got).toEqual({
              before: before.map((e) => e.handle),
              after: after.map((e) => e.handle),
            });
          prev = next;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('[PIN MA5 cost] unread, reorders adds no recompute and no key read: the same counts as keyArray without order', () => {
    const run = (subject: 'mapArray' | 'keyArray') => {
      let sourceRuns = 0;
      let keyReads = 0;
      const base = signal([user('a'), user('b'), user('c')]);
      const read = () => (sourceRuns++, base());
      const key = (v: User) => (keyReads++, v.id);
      const list =
        subject === 'mapArray'
          ? mapArray(read, (v) => v, { key })
          : keyArray(read, (v) => v, { key });
      list();
      base.set([...base()].reverse());
      list();
      base.set([user('z'), ...base()]);
      list();
      return { sourceRuns, keyReads };
    };
    expect(run('mapArray')).toEqual(run('keyArray'));
    expect(run('mapArray')).toEqual({ sourceRuns: 3, keyReads: 10 });
  });
});
