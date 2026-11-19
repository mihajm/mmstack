import { signal } from '@angular/core';

import { occurrences } from './occurrences';

type Item = { id: string };

const it_ = (id: string): Item => ({ id });
const row = () => document.createElement('div');

function setup(items: Item[]) {
  const source = signal<readonly Item[]>(items);
  const occ = occurrences(source, (i: Item) => i.id);
  return { source, occ };
}

describe('occurrences: published state', () => {
  it('a published state keeps its handles while the source moves on', () => {
    const { source, occ } = setup([it_('a'), it_('b')]);
    const s = occ.state();
    const snap = [...s.handles];
    for (const ids of [
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]) {
      source.set(ids.map(it_));
      occ.state();
    }
    expect(s.handles).toEqual(snap);
  });
});

describe('occurrences: binding rows to occurrences', () => {
  it('binds a row registered with its item, both ways', () => {
    const a = it_('a');
    const { occ } = setup([a, it_('b')]);
    const e1 = row();
    occ.register('a', e1, a);
    expect(occ.keyForElement(e1)).toBe(occ.handleAt(0));
    expect(occ.elementFor(occ.handleAt(0)!)).toBe(e1);
  });

  it('a reference listed several times binds its occurrences in registration order', () => {
    const a = it_('a');
    const { occ } = setup([a, a, a]);
    const els = [row(), row(), row()];
    for (const el of els) occ.register('a', el, a);
    els.forEach((el, i) => expect(occ.keyForElement(el)).toBe(occ.handleAt(i)));
  });

  it('rows registered by key alone bind distinct occurrences of a duplicate key', () => {
    const { occ } = setup([it_('x'), it_('x')]);
    const [e1, e2] = [row(), row()];
    occ.register('x', e1);
    occ.register('x', e2);
    const bound = [occ.keyForElement(e1), occ.keyForElement(e2)];
    expect(bound).not.toContain(undefined);
    expect(new Set(bound).size).toBe(2);
  });

  it('a row registered with a stale reference falls back to its key', () => {
    const stale = it_('a');
    const { source, occ } = setup([stale]);
    const e1 = row();
    occ.register('a', e1, stale);
    source.set([it_('a')]);
    expect(() => occ.keyForElement(e1)).not.toThrow();
    expect(occ.keyForElement(e1)).toBe(occ.handleAt(0));
  });

  it('a reference binds its own occurrence, not the first one of its key', () => {
    const [x1, x2] = [it_('x'), it_('x')];
    const { occ } = setup([x1, x2]);
    const e1 = row();
    occ.register('x', e1, x2);
    expect(occ.keyForElement(e1)).toBe(occ.handleAt(1));
  });

  it('a row whose reference occurrences are all taken binds by key', () => {
    const [x1, x2] = [it_('x'), it_('x')];
    const { occ } = setup([x1, x2]);
    const [e1, e2] = [row(), row()];
    occ.register('x', e1, x1);
    occ.register('x', e2, x1);
    expect(occ.keyForElement(e1)).toBe(occ.handleAt(0));
    expect(occ.keyForElement(e2)).toBe(occ.handleAt(1));
  });
});

describe('occurrences: register / unregister', () => {
  it('a re-rendered row (register new, unregister old, no read between) rebinds', () => {
    const a = it_('a');
    const { occ } = setup([a]);
    const [e1, e2] = [row(), row()];
    occ.register('a', e1, a);
    expect(occ.keyForElement(e1)).toBe(occ.handleAt(0));
    occ.register('a', e2, a);
    occ.unregister('a', e1);
    expect(occ.keyForElement(e2)).toBe(occ.handleAt(0));
    expect(occ.keyForElement(e1)).toBeUndefined();
  });

  it('a stale unregister does not evict a re-registration under another key', () => {
    const { occ } = setup([it_('k1'), it_('k2')]);
    const e = row();
    occ.register('k1', e);
    occ.register('k2', e);
    occ.unregister('k1', e);
    expect(occ.keyForElement(e)).toBe(occ.handleAt(1));
  });

  it('unregistering an unknown element is a no-op', () => {
    const { occ } = setup([it_('a')]);
    expect(() => occ.unregister('a', row())).not.toThrow();
  });

  it('an unregistered row no longer resolves', () => {
    const a = it_('a');
    const { occ } = setup([a]);
    const e1 = row();
    occ.register('a', e1, a);
    const h = occ.handleAt(0)!;
    expect(occ.elementFor(h)).toBe(e1);
    occ.unregister('a', e1);
    expect(occ.elementFor(h)).toBeUndefined();
  });
});
