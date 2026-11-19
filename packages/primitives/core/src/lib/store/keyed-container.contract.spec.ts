import { TestBed } from '@angular/core/testing';
import { opSync } from './op-sync';
import { store } from './store';
import {
  insertElement,
  orderedEntries,
  posBetween,
  rebalanceContainer,
  type ContainerNode,
} from './keyed-container';

type El = { title: string };
const ALPHABET = /^[0-9A-Za-z]+$/;

function setup(initial: Record<string, El & { '~pos'?: string }>) {
  return TestBed.runInInjectionContext(() => {
    const s = store<{ list: Record<string, El> }>({ list: initial });
    const sync = opSync(s, { writer: 'w' });
    const node = s.list as unknown as ContainerNode<El>;
    return { s, sync, node };
  });
}

const keysOf = (node: ContainerNode<El>) =>
  orderedEntries(node()).map((e) => e.key);
const posList = (node: ContainerNode<El>) =>
  orderedEntries(node()).map((e) => e.pos);

const expectStrictlyAscending = (ps: string[]) => {
  for (const p of ps) expect(p).toMatch(ALPHABET);
  for (let i = 1; i < ps.length; i++) expect(ps[i - 1] < ps[i]).toBe(true);
};

describe('posBetween bounds with no room', () => {
  it('returns for an upper bound that is the lower bound plus trailing zeros', () => {
    for (const [lo, hi] of [
      ['V', 'V0'],
      ['V', 'V00'],
      ['a1', 'a10'],
      [undefined, '0'],
    ] as const) {
      const p = posBetween(lo, hi);
      expect(p, `${lo}..${hi}`).toMatch(ALPHABET);
      if (lo !== undefined) expect(p > lo).toBe(true);
      expect(p).not.toBe(hi);
    }
  });

  it('an insert between an element at V and one at V0 terminates and keeps every element', () => {
    const { node } = setup({
      b: { '~pos': 'V', title: 'B' },
      a: { '~pos': 'V0', title: 'A' },
    });
    insertElement(node, 'x', { title: 'X' }, 1);
    expect(keysOf(node)).toHaveLength(3);
    expect(keysOf(node).slice(0, 2)).toEqual(['b', 'a']);
  });

  it('repeated inserts right after a fixed lower bound stay strictly between', () => {
    const lo = posBetween();
    let hi = posBetween(lo, undefined);
    for (let i = 0; i < 50; i++) {
      const m = posBetween(lo, hi);
      expect(m > lo && m < hi, `${lo} < ${m} < ${hi}`).toBe(true);
      expect(m).toMatch(ALPHABET);
      hi = m;
    }
  });
});

describe('orderedEntries contract', () => {
  it('a null element does not throw and sorts first, as if its position were empty', () => {
    const out = orderedEntries({
      real: { '~pos': '5', v: 1 },
      gone: null,
      und: undefined,
    } as Record<string, unknown>);
    expect(out.map((e) => e.key)).toEqual(['gone', 'und', 'real']);
    expect(out[0].pos).toBe('');
  });

  it('equal positions order by key whatever the key insertion order', () => {
    const keys = ['e', 'b', 'd', 'a', 'f', 'c'];
    const asc = [...keys].sort();
    for (const order of [keys, [...asc].reverse(), asc]) {
      const container: Record<string, { '~pos': string }> = {};
      for (const k of order) container[k] = { '~pos': 'V' };
      expect(orderedEntries(container).map((e) => e.key)).toEqual(asc);
    }
  });

  it('stores the position under the literal `~pos` key', () => {
    const { node } = setup({});
    insertElement(node, 'c', { title: 'C' }, 0);
    const pos = orderedEntries(node())[0].pos;
    expect(pos.length).toBeGreaterThan(0);
    expect(node()['c']).toHaveProperty('~pos', pos);
  });
});

describe('rebalanceContainer contract', () => {
  it('keeps reading order when key order is the opposite of position order', () => {
    const { node, sync } = setup({
      c: { '~pos': '1', title: 'C' },
      a: { '~pos': '2', title: 'A' },
      b: { '~pos': '3', title: 'B' },
    });
    rebalanceContainer(sync, node);
    expect(keysOf(node)).toEqual(['c', 'a', 'b']);
    expectStrictlyAscending(posList(node));
  });

  it('a single rebalanced element still accepts an insert in front of it', () => {
    const { node, sync } = setup({ only: { '~pos': 'k', title: 'O' } });
    rebalanceContainer(sync, node);
    expectStrictlyAscending(posList(node));
    insertElement(node, 'x', { title: 'X' }, 0);
    expect(keysOf(node)).toEqual(['x', 'only']);
  });

  it('an insert between two rebalanced elements lands where asked', () => {
    const { node, sync } = setup({
      z: { '~pos': '1', title: 'Z' },
      y: { '~pos': '2', title: 'Y' },
    });
    rebalanceContainer(sync, node);
    insertElement(node, 'm', { title: 'M' }, 1);
    expect(keysOf(node)).toEqual(['z', 'm', 'y']);
  });

  it('100 elements keep order and get distinct ascending positions', () => {
    const initial: Record<string, El & { '~pos': string }> = {};
    let pos: string | undefined;
    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      // keys sort in the reverse of reading order
      const key = `k${String(999 - i).padStart(3, '0')}`;
      pos = posBetween(pos, undefined);
      initial[key] = { '~pos': pos, title: key };
      expected.push(key);
    }
    const { node, sync } = setup(initial);
    rebalanceContainer(sync, node);
    expect(keysOf(node)).toEqual(expected);
    const ps = posList(node);
    expectStrictlyAscending(ps);
    expect(new Set(ps).size).toBe(100);
  });
});
