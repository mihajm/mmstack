import { selection } from './selection';

describe('selection', () => {
  it('adds, toggles and removes ids (multi by default)', () => {
    const sel = selection<number>();
    sel.add(1);
    sel.add(2);
    expect(sel.ids()).toEqual([1, 2]);
    expect(sel.has(1)).toBe(true);
    expect(sel.size()).toBe(2);

    sel.toggle(1);
    expect(sel.has(1)).toBe(false);
    expect(sel.ids()).toEqual([2]);

    sel.toggle(3);
    expect(sel.ids()).toEqual([2, 3]);

    sel.remove(2);
    expect(sel.ids()).toEqual([3]);
  });

  it('ignores duplicate adds and missing removes', () => {
    const sel = selection<string>();
    sel.add('a');
    sel.add('a');
    expect(sel.ids()).toEqual(['a']);
    sel.remove('zzz');
    expect(sel.ids()).toEqual(['a']);
  });

  it('set replaces and clear empties', () => {
    const sel = selection<number>();
    sel.set([1, 2, 3]);
    expect(sel.ids()).toEqual([1, 2, 3]);
    sel.clear();
    expect(sel.ids()).toEqual([]);
  });

  it('single-select mode keeps at most one id', () => {
    const sel = selection<number>({ multi: false });
    sel.add(1);
    sel.add(2);
    expect(sel.ids()).toEqual([2]);
    sel.toggle(3);
    expect(sel.ids()).toEqual([3]);
    sel.set([7, 8, 9]);
    expect(sel.ids()).toEqual([7]);
  });
});
