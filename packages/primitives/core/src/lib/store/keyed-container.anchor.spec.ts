/**
 * `moveElement` with a neighbour anchor: resolved against the container's CURRENT order at apply
 * time, so a concurrent insert between the original neighbours does not misplace the move. The
 * index form is pinned byte-identical to the pre-change function.
 */
import { signal } from '@angular/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Anchor,
  type ContainerNode,
  insertElement,
  keyedContainer,
  moveElement,
  orderedEntries,
  POS_SEGMENT,
  posBetween,
} from './keyed-container';

type El = { readonly v: number; readonly '~pos'?: string };

const order = (c: ContainerNode<El>) => orderedEntries(c()).map((e) => e.key);

function container(keys: readonly string[]): ContainerNode<El> {
  const c = signal<Record<string, El>>({});
  keys.forEach((k, i) => insertElement(c, k, { v: i }));
  return c;
}

/** `moveElement` at ca774aa8 (index form only), copied for the byte-equality pin. */
function legacyMove<T extends object>(
  c: ContainerNode<T>,
  key: string,
  index: number,
): string | undefined {
  const current = c()[key];
  if (current == null) return undefined;
  const entries = orderedEntries(c()).filter((e) => e.key !== key);
  const clamped = Math.max(0, Math.min(index, entries.length));
  const pos = posBetween(
    entries[clamped - 1]?.pos || undefined,
    entries[clamped]?.pos || undefined,
  );
  c.update((x) => ({ ...x, [key]: { ...x[key], [POS_SEGMENT]: pos } }));
  return pos;
}

describe('moveElement — neighbour anchors', () => {
  it('[PIN anchor concurrent] resolves against the current order after an insert between the neighbours', () => {
    const after: Anchor = { after: 'a' };
    const before: Anchor = { before: 'b' };

    const c1 = container(['a', 'b', 'c', 'd']);
    insertElement(c1, 'x', { v: 9 }, 1); // concurrent: x lands between a and b
    expect(moveElement(c1, 'd', after)).toBeTypeOf('string');
    expect(order(c1)).toEqual(['a', 'd', 'x', 'b', 'c']);

    const c2 = container(['a', 'b', 'c', 'd']);
    insertElement(c2, 'x', { v: 9 }, 1);
    moveElement(c2, 'd', before);
    expect(order(c2)).toEqual(['a', 'x', 'd', 'b', 'c']);
  });

  it('[PIN anchor concurrent] a prepend does not shift the anchored target (the index form would)', () => {
    const c = container(['a', 'b', 'c']);
    insertElement(c, 'y', { v: 9 }, 0);
    moveElement(c, 'c', { after: 'a' });
    expect(order(c)).toEqual(['y', 'a', 'c', 'b']);
  });

  it('[PIN anchor absent] an anchor naming an absent key is a no-op: nothing written', () => {
    const c = container(['a', 'b', 'c']);
    const snapshot = c();
    expect(moveElement(c, 'c', { after: 'gone' })).toBeUndefined();
    expect(moveElement(c, 'c', { before: 'gone' })).toBeUndefined();
    expect(moveElement(c, 'c', { after: 'c' })).toBeUndefined();
    expect(c()).toBe(snapshot);
  });

  it('[PIN anchor empty] `empty` places the only element; with siblings it is a no-op', () => {
    const lone = container(['a']);
    expect(moveElement(lone, 'a', { empty: true })).toBeTypeOf('string');
    expect(order(lone)).toEqual(['a']);

    const c = container(['a', 'b']);
    const snapshot = c();
    expect(moveElement(c, 'a', { empty: true })).toBeUndefined();
    expect(c()).toBe(snapshot);
  });

  it('[PIN anchor] the moved key itself absent stays a no-op', () => {
    const c = container(['a']);
    const snapshot = c();
    expect(moveElement(c, 'zz', { after: 'a' })).toBeUndefined();
    expect(c()).toBe(snapshot);
  });

  it('[PIN anchor index byte-equal] the index form matches the pre-change function', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    fc.assert(
      fc.property(
        fc.subarray(keys, { minLength: 1 }),
        fc.nat({ max: 6 }),
        fc.integer({ min: -2, max: 8 }),
        (present, which, index) => {
          const key = present[which % present.length];
          const x = container(present);
          const y = container(present);
          expect(moveElement(x, key, index)).toEqual(legacyMove(y, key, index));
          expect(x()).toEqual(y());
        },
      ),
      { numRuns: 300 },
    );
  });
});

/** `orderedEntries` at ca774aa8 (entry objects + sort), copied for the ordering-equivalence pin. */
function legacyOrderedEntries<T>(container: Record<string, T>) {
  const entries: { key: string; pos: string; value: T }[] = [];
  for (const key of Object.keys(container)) {
    const element = container[key];
    const raw =
      typeof element === 'object' && element !== null && !Array.isArray(element)
        ? (element as Record<string, unknown>)[POS_SEGMENT]
        : undefined;
    entries.push({
      key,
      pos: typeof raw === 'string' ? raw : '',
      value: element,
    });
  }
  entries.sort((a, b) =>
    a.pos < b.pos
      ? -1
      : a.pos > b.pos
        ? 1
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0,
  );
  return entries;
}

/** Runs `fn` with `Array.prototype.sort` counting its calls. */
function countingSorts(fn: () => void): number {
  const original = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (
    this: unknown[],
    cmp?: (a: unknown, b: unknown) => number,
  ) {
    sorts++;
    return original.call(this, cmp);
  } as typeof original;
  try {
    fn();
  } finally {
    Array.prototype.sort = original;
  }
  return sorts;
}

describe('insertElement — neighbour anchors', () => {
  it('[PIN anchor insert] `{ after: c }` lands right after c after a concurrent insert between the old neighbours', () => {
    const c = container(['a', 'b', 'c', 'd']);
    insertElement(c, 'x', { v: 9 }, 3); // concurrent: x lands between c and d
    expect(insertElement(c, 'n', { v: 7 }, { after: 'c' })).toBeTypeOf(
      'string',
    );
    expect(order(c)).toEqual(['a', 'b', 'c', 'n', 'x', 'd']);
    insertElement(c, 'm', { v: 8 }, { before: 'a' });
    expect(order(c)[0]).toBe('m');
  });

  it('[PIN anchor insert absent] an absent neighbour leaves the container untouched', () => {
    const c = container(['a', 'b']);
    const snapshot = c();
    expect(insertElement(c, 'n', { v: 1 }, { after: 'gone' })).toBeUndefined();
    expect(insertElement(c, 'n', { v: 1 }, { empty: true })).toBeUndefined();
    expect(c()).toBe(snapshot);
    const empty = container([]);
    expect(insertElement(empty, 'n', { v: 1 }, { empty: true })).toBeTypeOf(
      'string',
    );
    expect(order(empty)).toEqual(['n']);
  });

  it('[PIN anchor insert helpers] keyedContainer().insert takes an anchor too', () => {
    const slots = keyedContainer({
      key: (e: { id: string; v: number }) => e.id,
    });
    const c = signal<Record<string, { id: string; v: number }>>({});
    slots.insert(c, { id: 'a', v: 1 });
    slots.insert(c, { id: 'b', v: 2 });
    slots.insert(c, { id: 'n', v: 3 }, { before: 'b' });
    expect(slots.entries(c()).map((e) => e.key)).toEqual(['a', 'n', 'b']);
  });
});

describe('keyed-container ordering without entry objects', () => {
  it('[PIN order equivalence] orderedEntries matches the pre-change implementation (ties, empty and bad pos)', () => {
    const pos = fc.oneof(
      fc.constantFrom('', 'V', 'V', 'a0', 'b'),
      fc.string({ maxLength: 3 }),
      fc.constant(undefined),
      fc.constant(7),
    );
    const containers = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 3 }),
      fc.oneof(
        fc.record({ v: fc.nat(), '~pos': pos }),
        fc.constant(null),
        fc.nat(),
      ),
      { maxKeys: 12 },
    );
    fc.assert(
      fc.property(containers, (raw) => {
        const c = raw as Record<string, unknown>;
        expect(orderedEntries(c)).toEqual(legacyOrderedEntries(c));
      }),
      { numRuns: 400 },
    );
  });

  it('[PIN order equivalence] anchors place exactly where the matching index would', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    fc.assert(
      fc.property(
        fc.subarray(keys, { minLength: 2 }),
        fc.nat({ max: 6 }),
        fc.nat({ max: 6 }),
        fc.boolean(),
        fc.boolean(),
        (present, m, n, after, tie) => {
          const mover = present[m % present.length];
          const others = present.filter((k) => k !== mover);
          const anchorKey = others[n % others.length];
          const x = container(present);
          if (tie && others.length > 1) {
            // two neighbours tied on ~pos, ordered by key
            const [k1, k2] = others;
            x.update((c) => ({
              ...c,
              [k2]: { ...c[k2], '~pos': c[k1]['~pos'] },
            }));
          }
          const y = signal(x());
          const slot = orderedEntries(x())
            .filter((e) => e.key !== mover)
            .findIndex((e) => e.key === anchorKey);
          moveElement(
            x,
            mover,
            after ? { after: anchorKey } : { before: anchorKey },
          );
          moveElement(y, mover, after ? slot + 1 : slot);
          expect(x()).toEqual(y());
        },
      ),
      { numRuns: 300 },
    );
  });

  it('[PIN anchor no sort] resolving an anchor never sorts; an index still does', () => {
    const c = container(['a', 'b', 'c', 'd']);
    expect(countingSorts(() => moveElement(c, 'd', { after: 'a' }))).toBe(0);
    expect(
      countingSorts(() => insertElement(c, 'n', { v: 1 }, { before: 'b' })),
    ).toBe(0);
    expect(countingSorts(() => moveElement(c, 'd', 0))).toBeGreaterThan(0);
  });
});
