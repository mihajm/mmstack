/**
 * keyArray over continuity handles: the duplicate-key pins (survivors keep their own entries) and
 * the byte-equality pin against the pre-change implementation on duplicate-free histories.
 */
import {
  computed,
  isSignal,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isKeyHandle } from './handles';
import { keyArray } from './key-array';

/** The removed pre-change option, kept for the legacy copy. */
type DuplicateKeyPolicy = {
  policy: 'ordinal';
  report?: (bases: readonly string[]) => void;
};

// ---------------------------------------------------------------- the pre-change implementation
// Copied verbatim from key-array.ts at ca774aa8 (renamed only), for the byte-equality pin.

function legacyEffectiveKeys<T, K>(
  arr: readonly T[],
  getKey: (item: T) => K,
  report?: (bases: readonly string[]) => void,
): string[] {
  const out = new Array<string>(arr.length);
  const counts = new Map<string, number>();
  const firstOrder: string[] = [];
  let duped: Set<string> | null = null;

  for (let i = 0; i < arr.length; i++) {
    const base = String(getKey(arr[i]));
    const seen = counts.get(base) ?? 0;
    if (seen === 0) {
      firstOrder.push(base);
    } else {
      (duped ??= new Set<string>()).add(base);
    }
    out[i] = seen === 0 ? base : base + '#' + seen;
    counts.set(base, seen + 1);
  }

  if (report && duped) {
    const bases = firstOrder.filter((b) => duped.has(b));
    untracked(() => report(bases));
  }

  return out;
}

function legacyKeyArray<T, U, K>(
  source: Signal<T[]> | (() => T[]),
  mapFn: (v: T, i: Signal<number>, key: K | string) => U,
  options: {
    onDestroy?: (value: U) => void;
    /**
     * Optional function to use a custom key for item comparison.
     * Use this if you want to reuse mapped items based on a property (like an ID)
     * even if the item reference changes.
     */
    key?: (item: T) => K;
    /**
     * Opt-in policy for disambiguating duplicate keys. When present, keys are
     * coerced to strings and duplicates get distinct ordinal effective keys
     * (`base`, `base#1`, `base#2`, ...). When absent, behavior is unchanged.
     */
    duplicateKeys?: DuplicateKeyPolicy;
  } = {},
): Signal<U[]> {
  const sourceSignal = isSignal(source) ? source : computed(source);

  const items: T[] = [];
  let mapped: U[] = [];
  const indexes: WritableSignal<number>[] = [];
  const getKey = options.key || ((v) => v as unknown as K);

  const newIndices = new Map<K, number>();
  const temp: U[] = [];
  const tempIndexes: WritableSignal<number>[] = [];
  const newIndicesNext: number[] = [];

  const newIndexesCache = new Array<WritableSignal<number>>();

  const dup = options.duplicateKeys;

  return computed(() => {
    const newItems = sourceSignal() || [];

    return untracked(() => {
      const newKeys = dup
        ? legacyEffectiveKeys(newItems, getKey, dup.report)
        : null;
      let i: number;
      let j: number;
      const newLen = newItems.length;
      const len = items.length;
      const newMapped = new Array<U>(newLen);
      const newIndexes = newIndexesCache;
      newIndexes.length = 0;
      newIndexes.length = newLen;

      let start: number;
      let end: number;
      let newEnd: number;
      let item: T;
      let key: any;

      if (newLen === 0) {
        if (len !== 0) {
          if (options.onDestroy) {
            for (let k = 0; k < len; k++) options.onDestroy(mapped[k]);
          }
          items.length = 0;
          mapped = [];
          indexes.length = 0;
        }
        return mapped;
      }

      if (len === 0) {
        for (j = 0; j < newLen; j++) {
          item = newItems[j];
          items[j] = item;
          const indexSignal = signal(j);
          newIndexes[j] = indexSignal;
          newMapped[j] = mapFn(
            item,
            indexSignal,
            newKeys ? newKeys[j] : getKey(item),
          );
        }
      } else {
        newIndices.clear();
        temp.length = 0;
        tempIndexes.length = 0;
        newIndicesNext.length = 0;

        const oldKeys = dup ? legacyEffectiveKeys(items, getKey) : null;
        const kNew = newKeys
          ? (idx: number) => newKeys[idx]
          : (idx: number) => getKey(newItems[idx]);
        const kOld = oldKeys
          ? (idx: number) => oldKeys[idx]
          : (idx: number) => getKey(items[idx]);

        for (
          start = 0, end = Math.min(len, newLen);
          start < end && kOld(start) === kNew(start);
          start++
        ) {
          newMapped[start] = mapped[start];
          newIndexes[start] = indexes[start];
        }

        for (
          end = len - 1, newEnd = newLen - 1;
          end >= start && newEnd >= start && kOld(end) === kNew(newEnd);
          end--, newEnd--
        ) {
          temp[newEnd] = mapped[end];
          tempIndexes[newEnd] = indexes[end];
        }

        for (j = newEnd; j >= start; j--) {
          key = kNew(j);
          i = newIndices.get(key) ?? -1;
          newIndicesNext[j] = i === undefined ? -1 : i;
          newIndices.set(key, j);
        }

        for (i = start; i <= end; i++) {
          key = kOld(i);
          j = newIndices.get(key) ?? -1;
          if (j !== undefined && j !== -1) {
            temp[j] = mapped[i];
            tempIndexes[j] = indexes[i];
            j = newIndicesNext[j];
            newIndices.set(key, j);
          } else {
            if (options.onDestroy) options.onDestroy(mapped[i]);
          }
        }

        // 2) Set all new values
        for (j = start; j < newLen; j++) {
          if (temp[j] !== undefined) {
            newMapped[j] = temp[j];
            newIndexes[j] = tempIndexes[j];
            newIndexes[j].set(j);
          } else {
            const indexSignal = signal(j);
            newIndexes[j] = indexSignal;
            newMapped[j] = mapFn(newItems[j], indexSignal, kNew(j));
          }
        }

        items.length = newLen;
        for (let k = 0; k < newLen; k++) items[k] = newItems[k];
      }

      mapped = newMapped;

      indexes.length = newLen;
      for (let k = 0; k < newLen; k++) indexes[k] = newIndexes[k];

      return mapped;
    });
  });
}

// ---------------------------------------------------------------- harness

type Item = { readonly id: string | number; readonly tag: string };
type Entry = { item: Item; uid: number; key: unknown; index: Signal<number> };
type Impl = typeof legacyKeyArray<Item, Entry, string | number>;

/**
 * `withHandles` turns on the legacy `duplicateKeys: { policy: 'ordinal' }` AND the current
 * `handles: true` (each implementation ignores the other's option): the pre-change and the new way
 * of handing `mapFn` a per-occurrence key.
 */
function tracked(impl: Impl, initial: Item[], withHandles = false) {
  const source = signal(initial);
  let uid = 0;
  const created: Entry[] = [];
  const destroyed: Entry[] = [];
  const mapped = impl(
    source,
    (item, index, key) => {
      const entry = { item, uid: uid++, key, index };
      created.push(entry);
      return entry;
    },
    {
      key: (item) => item.id,
      onDestroy: (entry) => destroyed.push(entry),
      ...((withHandles
        ? {
            duplicateKeys: { policy: 'ordinal' } satisfies DuplicateKeyPolicy,
            handles: true,
          }
        : {}) as { duplicateKeys?: DuplicateKeyPolicy }),
    },
  );
  return { source, mapped, created, destroyed };
}

const current = keyArray as unknown as Impl;
const legacyImpl: Impl = legacyKeyArray<Item, Entry, string | number>;
const item = (id: string | number, tag: string): Item => ({ id, tag });

describe('keyArray — survivors keep their own entries', () => {
  it('[PIN M2 K-dup] [a1,a2] → [a2] without the option: the survivor is the entry built from a2', () => {
    const a1 = item('a', '1');
    const a2 = item('a', '2');
    const t = tracked(current, [a1, a2]);
    const [e1, e2] = t.mapped();
    t.source.set([a2]);
    expect(t.mapped()).toEqual([e2]);
    expect(t.mapped()[0]).toBe(e2);
    expect(t.mapped()[0].item).toBe(a2);
    expect(t.destroyed).toEqual([e1]);
    expect(t.created).toHaveLength(2);
    expect(e2.index()).toBe(0);
  });

  it('[PIN M2 promotion] a reference-identifiable survivor is never re-created', () => {
    const x = item('a', 'x');
    const y = item('a', 'y');
    const z = item('a', 'z');
    const t = tracked(current, [x, y, z], true);
    const [ex, ey, ez] = t.mapped();
    t.source.set([y, z]);
    expect(t.mapped()[0]).toBe(ey);
    expect(t.mapped()[1]).toBe(ez);
    expect(t.destroyed).toEqual([ex]);
    expect(t.created).toHaveLength(3);
    expect([ey.index(), ez.index()]).toEqual([0, 1]);
  });

  for (const ordinal of [false, true]) {
    const mode = ordinal ? 'handles' : 'no option';
    describe(`[PIN M2-U-D-U-IMMUTABLE] (${mode})`, () => {
      it('[a1] → [a1,a2] → [a2] → [a2′]: a2 keeps its entry and handle through the replacement', () => {
        const a1 = item('a', '1');
        const a2 = item('a', '2');
        const t = tracked(current, [a1], ordinal);
        const [e1] = t.mapped();
        t.source.set([a1, a2]);
        const s1 = t.mapped();
        expect(s1[0]).toBe(e1);
        const e2 = s1[1];
        expect(t.created).toEqual([e1, e2]);
        t.source.set([a2]);
        expect(t.mapped()).toEqual([e2]);
        expect(t.mapped()[0]).toBe(e2);
        expect(e2.index()).toBe(0);
        expect(t.destroyed).toEqual([e1]);
        t.source.set([item('a', '2′')]);
        expect(t.mapped()[0]).toBe(e2);
        expect(t.created).toHaveLength(2);
        expect(t.destroyed).toHaveLength(1);
        if (ordinal) {
          expect(e1.key).toBe('a');
          expect(isKeyHandle(e2.key)).toBe(true);
        } else expect([e1.key, e2.key]).toEqual(['a', 'a']);
      });

      it('[a1] → [a1,a2] → [a1] → [a1′]: a1 keeps its raw handle and entry throughout', () => {
        const a1 = item('a', '1');
        const a2 = item('a', '2');
        const t = tracked(current, [a1], ordinal);
        const [e1] = t.mapped();
        t.source.set([a1, a2]);
        const e2 = t.mapped()[1];
        t.source.set([a1]);
        expect(t.mapped()[0]).toBe(e1);
        t.source.set([item('a', '1′')]);
        expect(t.mapped()[0]).toBe(e1);
        expect(e1.key).toBe('a');
        expect(t.created).toEqual([e1, e2]);
        expect(t.destroyed).toEqual([e2]);
      });

      it('ambiguity control [a1] → [a1,a2] → [a2′]: both retire, one fresh entry', () => {
        const a1 = item('a', '1');
        const a2 = item('a', '2');
        const t = tracked(current, [a1], ordinal);
        const [e1] = t.mapped();
        t.source.set([a1, a2]);
        const e2 = t.mapped()[1];
        t.source.set([item('a', '2′')]);
        const [e3] = t.mapped();
        expect(e3).not.toBe(e1);
        expect(e3).not.toBe(e2);
        expect(t.created).toHaveLength(3);
        expect(t.destroyed).toEqual([e1, e2]);
        if (ordinal) expect(isKeyHandle(e3.key)).toBe(true);
      });
    });
  }

  it('[PIN M2 multiplicity] [x,x] → [x]: one destroy, zero creates, the first entry survives', () => {
    const x = item('a', 'x');
    const t = tracked(current, [x, x], true);
    const [first, second] = t.mapped();
    t.source.set([x]);
    expect(t.mapped()[0]).toBe(first);
    expect(t.destroyed).toEqual([second]);
    expect(t.created).toHaveLength(2);
  });

  it('[PIN M2 ambiguous] [a1,a2] → [a3] (fresh, other count): two destroys, one create', () => {
    const t = tracked(current, [item('a', '1'), item('a', '2')], true);
    const before = t.mapped();
    t.source.set([item('a', '3')]);
    const [fresh] = t.mapped();
    expect(before).not.toContain(fresh);
    expect(t.destroyed).toEqual(before);
    expect(t.created).toHaveLength(3);
  });

  it('[PIN M2 no collision] a user key `a#1` beside duplicate `a`s gets its own entry', () => {
    const items = [item('a', '1'), item('a', '2'), item('a#1', 'u')];
    const t = tracked(current, items, true);
    const first = t.mapped();
    expect(new Set(first).size).toBe(3);
    expect(first[2].key).toBe('a#1');
    expect(new Set(first.map((e) => e.key)).size).toBe(3);
    t.source.set([...items]);
    expect(t.mapped()).toEqual(first);
    expect(t.created).toHaveLength(3);
    expect(t.destroyed).toHaveLength(0);
  });

  it('[PIN M2 key type] without the option mapFn receives the raw key, also for duplicates', () => {
    const t = tracked(current, [
      item('a', '1'),
      item('a', '2'),
      item('b', '3'),
    ]);
    t.mapped();
    expect(t.created.map((e) => e.key)).toEqual(['a', 'a', 'b']);
  });
});

describe('keyArray — byte-equal to the pre-change implementation on duplicate-free histories', () => {
  // numeric keys (incl. NaN) only without the option: with it, the old code coerced keys to
  // strings, a known delta pinned below
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

  for (const ordinal of [false, true]) {
    const step = stepOf(ordinal);
    it(`[PIN M2 byte-equal] outputs, entry identity, index values and destroys match (${ordinal ? 'handles' : 'no option'})`, () => {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
          const legacy = tracked(legacyImpl, [], ordinal);
          const next = tracked(current, [], ordinal);
          let last = new Map<string | number, Item>();
          const view = (t: ReturnType<typeof tracked>) => ({
            uids: t.mapped().map((e) => e.uid),
            index: t.mapped().map((e) => e.index()),
            destroyed: t.destroyed.map((e) => e.uid),
            keys: t.created.map((e) => e.key),
          });
          for (const { ids, fresh } of steps) {
            const items = ids.map(
              (id, i) => (!fresh[i] && last.get(id)) || item(id, `${i}`),
            );
            last = new Map(items.map((it) => [it.id, it]));
            legacy.source.set(items);
            next.source.set(items);
            expect(view(next)).toEqual(view(legacy));
          }
        }),
        { numRuns: 300 },
      );
    });
  }
});

describe('keyArray — the legacy copy reproduces the bug it pins against', () => {
  it('legacy [a1,a2] → [a2] keeps the entry built from a1 (K-dup, recorded for the handback)', () => {
    const a1 = item('a', '1');
    const a2 = item('a', '2');
    const t = tracked(legacyImpl, [a1, a2]);
    const [e1, e2] = t.mapped();
    t.source.set([a2]);
    expect(t.mapped()[0]).toBe(e1);
    expect(t.destroyed).toEqual([e2]);
  });
});

describe('keyArray — the known delta from the pre-change implementation', () => {
  it('[PIN M2 delta undefined] a mapFn returning undefined is reused on reorder (the old code re-ran it)', () => {
    const calls = (impl: typeof legacyKeyArray<string, undefined, string>) => {
      const source = signal(['a', 'b']);
      let n = 0;
      const mapped = impl(source, () => {
        n++;
        return undefined;
      });
      mapped();
      source.set(['b', 'a']);
      mapped();
      return n;
    };
    expect(calls(legacyKeyArray)).toBe(4);
    expect(
      calls(
        keyArray as unknown as typeof legacyKeyArray<string, undefined, string>,
      ),
    ).toBe(2);
  });
});

describe('keyArray — onDuplicates', () => {
  it('[PIN M2 onDuplicates] reports the actual keys (objects, no String coercion), first-occurrence order, once per recompute', () => {
    const k1 = { k: 1 };
    const k2 = { k: 2 };
    const k3 = { k: 3 };
    const source = signal([k2, k1, k2, k3, k1, k1]);
    const seen: (readonly unknown[])[] = [];
    const mapped = keyArray(source, (v) => v, {
      onDuplicates: (keys) => seen.push(keys),
    });
    mapped();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([k2, k1]);
    expect(seen[0][0]).toBe(k2);
    source.set([k1, k2, k3]);
    mapped();
    expect(seen).toHaveLength(1);
  });

  it('[PIN M2 onDuplicates] 1 and "1" are different keys', () => {
    const seen: unknown[] = [];
    const mapped = keyArray(signal<(string | number)[]>([1, '1']), (v) => v, {
      onDuplicates: (keys) => seen.push(keys),
    });
    mapped();
    expect(seen).toEqual([]);
  });
});

describe('keyArray — raw re-issue', () => {
  it('[PIN M2 raw re-issue] [a] → [a, a2] → [a3]: the entry for a3 is new, no object crosses', () => {
    const [a, a2, a3] = [item('a', '1'), item('a', '2'), item('a', '3')];
    const t = tracked(current, [a], true);
    const [ea] = t.mapped();
    t.source.set([a, a2]);
    const [, ea2] = t.mapped();
    t.source.set([a3]);
    const [e3] = t.mapped();
    expect(e3.item).toBe(a3);
    expect(e3).not.toBe(ea);
    expect(e3).not.toBe(ea2);
    expect(t.created).toHaveLength(3);
    expect(t.destroyed).toEqual([ea, ea2]);
    expect(isKeyHandle(e3.key)).toBe(true);
  });
});
