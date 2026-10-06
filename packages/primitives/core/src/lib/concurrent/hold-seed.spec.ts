import { computed, signal } from '@angular/core';
import {
  beginOwnHold,
  endOwnHold,
  heldSince,
  holdIntervalCount,
  holdRegistrySize,
  inheritHoldSeeds,
  preHoldValueOf,
  recordHoldEntry,
  redirectHoldSeeds,
} from './hold-seed';

const seed = (scope: object, sig: object) => preHoldValueOf(scope, sig)?.value;

describe('hold registry', () => {
  afterEach(() => expect(holdRegistrySize()).toBe(0));

  it('records nothing while no scope holds; a lookup outside a hold finds nothing', () => {
    const a = signal(0);
    const scope = {};
    recordHoldEntry(a, 'ignored');
    expect([holdRegistrySize(), heldSince(scope), seed(scope, a)]).toEqual([
      0,
      undefined,
      undefined,
    ]);
  });

  it('the first entry since the hold began seeds; every entry is kept, not one per writer', () => {
    const a = signal(0);
    const x = {};
    const y = {};
    beginOwnHold(x);
    recordHoldEntry(a, 'before-y');
    beginOwnHold(y);
    recordHoldEntry(a, 'after-y'); // the same writer again, inside y's hold
    expect([seed(x, a), seed(y, a), holdRegistrySize()]).toEqual([
      'before-y',
      'after-y',
      2,
    ]);
    endOwnHold(x);
    // y is unrelated to x and began after the first entry: only its own entry stays readable
    expect([holdRegistrySize(), seed(y, a)]).toEqual([1, 'after-y']);
    endOwnHold(y);
  });

  it('a found undefined is an answer, distinct from not knowing', () => {
    const a = signal<number | undefined>(1);
    const x = {};
    beginOwnHold(x);
    recordHoldEntry(a, undefined);
    expect(preHoldValueOf(x, a)).toMatchObject({
      found: true,
      value: undefined,
    });
    expect(preHoldValueOf(x, signal(0))).toBeUndefined();
    endOwnHold(x);
  });

  it('a scope inherits the holds of the scope it was created inside: the stretch starts at the earliest connected hold', () => {
    const a = signal(0);
    const page = {};
    const child = {};
    inheritHoldSeeds(child, page);
    beginOwnHold(child); // the child holds first
    recordHoldEntry(a, 'child-pre');
    beginOwnHold(page);
    recordHoldEntry(a, 'page-pre');
    endOwnHold(child); // its own hold ends under the page's
    expect([seed(child, a), seed(page, a)]).toEqual(['child-pre', 'page-pre']);
    beginOwnHold(child); // holds again, the page held all along
    expect(seed(child, a)).toBe('child-pre');
    endOwnHold(page); // the page ends first; the child still holds
    expect(seed(child, a)).toBe('child-pre');
    expect(seed(page, a)).toBeUndefined(); // the page does not inherit from the child
    endOwnHold(child);
  });

  it('a gap breaks the stretch: a hold after one that ended does not see its entries', () => {
    const a = signal(0);
    const page = {};
    const child = {};
    const other = {}; // keeps the registry alive across the gap
    inheritHoldSeeds(child, page);
    beginOwnHold(other);
    beginOwnHold(page);
    recordHoldEntry(a, 'first');
    endOwnHold(page);
    recordHoldEntry(a, 'between');
    beginOwnHold(child);
    recordHoldEntry(a, 'second');
    expect([seed(child, a), seed(other, a)]).toEqual(['second', 'first']);
    endOwnHold(child);
    endOwnHold(other);
  });

  it('when the last hold anywhere ends the registry is cleared and older holds are void', () => {
    const a = signal(0);
    const x = {};
    beginOwnHold(x);
    recordHoldEntry(a, 'old');
    endOwnHold(x);
    expect(holdRegistrySize()).toBe(0);
    beginOwnHold(x);
    expect([seed(x, a), heldSince(x) !== undefined]).toEqual([undefined, true]);
    recordHoldEntry(a, 'new');
    expect(seed(x, a)).toBe('new');
    endOwnHold(x);
  });

  it('a forwarding scope resolves to its current target', () => {
    const a = signal(0);
    const t1 = {};
    const t2 = {};
    let target = t1;
    const fwd = {};
    redirectHoldSeeds(fwd, () => target);
    beginOwnHold(t1);
    recordHoldEntry(a, 'pre');
    expect(seed(fwd, a)).toBe('pre');
    target = t2;
    expect(seed(fwd, a)).toBeUndefined();
    endOwnHold(t1);
  });

  it('a lookup inside a reactive context tracks nothing', () => {
    const a = signal(0);
    const x = {};
    beginOwnHold(x);
    recordHoldEntry(a, 'pre');
    let runs = 0;
    const reader = computed(() => {
      runs++;
      return seed(x, a);
    });
    expect(reader()).toBe('pre');
    a.set(5);
    recordHoldEntry(a, 'later');
    expect([reader(), runs]).toEqual(['pre', 1]);
    endOwnHold(x);
  });
});

describe('hold registry reclamation', () => {
  afterEach(() =>
    expect([holdRegistrySize(), holdIntervalCount()]).toEqual([0, 0]),
  );

  it('two unrelated scopes alternating overlapping holds for 20 rounds: the registry stays bounded and seeds stay right', () => {
    const a = signal(0);
    const left = {};
    const right = {};
    beginOwnHold(left);
    recordHoldEntry(a, 'L0');
    const sizes: number[] = [];
    let prev = left;
    for (let round = 1; round <= 20; round++) {
      const next = round % 2 ? right : left;
      beginOwnHold(next); // overlaps the previous hold: nothing ever reaches zero
      recordHoldEntry(a, `pre-${round}`);
      recordHoldEntry(a, `again-${round}`);
      endOwnHold(prev);
      expect(seed(next, a)).toBe(`pre-${round}`);
      sizes.push(holdRegistrySize());
      expect(holdIntervalCount()).toBeLessThanOrEqual(2); // the live hold and the one it overlapped
      prev = next;
    }
    // only the live stretch's two entries are kept, whatever the history length
    expect(new Set(sizes)).toEqual(new Set([2]));
    endOwnHold(prev);
  });

  it('a scope held throughout keeps its frame across the churn of an unrelated one', () => {
    const a = signal(0);
    const steady = {};
    const churn = {};
    beginOwnHold(steady);
    recordHoldEntry(a, 'steady-pre');
    for (let round = 0; round < 20; round++) {
      beginOwnHold(churn);
      recordHoldEntry(a, `churn-${round}`);
      expect(seed(churn, a)).toBe(`churn-${round}`);
      endOwnHold(churn);
      expect(seed(steady, a)).toBe('steady-pre');
    }
    // the held scope's whole stretch is the remaining bound: everything since it began
    expect(holdRegistrySize()).toBe(21);
    endOwnHold(steady);
  });

  it('a child whose own hold ended inside its parent hold still reads from its earlier start after a prune', () => {
    const a = signal(0);
    const page = {};
    const child = {};
    const other = {};
    inheritHoldSeeds(child, page);
    beginOwnHold(child);
    recordHoldEntry(a, 'child-pre'); // before the page holds
    beginOwnHold(page);
    endOwnHold(child); // the child stays held through the page
    beginOwnHold(other); // an unrelated boundary prunes
    endOwnHold(other);
    expect([
      (heldSince(child) ?? Infinity) < (heldSince(page) ?? -1),
      seed(child, a),
    ]).toEqual([true, 'child-pre']);
    endOwnHold(page);
  });
});
