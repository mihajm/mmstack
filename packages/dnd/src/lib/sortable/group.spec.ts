import { type RectLike } from './geometry';
import {
  getGroupInternals,
  isSortableGroup,
  sortableGroup,
  type SortableGroupMember,
} from './group';

const member = (bounds: RectLike | null): SortableGroupMember => ({
  bounds: () => bounds,
  refreshBounds: () => undefined,
  measure: () => ({ centers: [], axis: 'y' }),
  insertAt: () => undefined,
});

describe('sortableGroup', () => {
  it('registers / unregisters members idempotently', () => {
    const g = sortableGroup();
    const a = member(null);
    g.register(a);
    g.register(a); // idempotent
    expect(g.members()).toEqual([a]);
    g.unregister(a);
    expect(g.members()).toEqual([]);
  });

  it('resolves the member whose container contains the point', () => {
    const g = sortableGroup();
    const left = member({ top: 0, left: 0, width: 100, height: 100 });
    const right = member({ top: 0, left: 200, width: 100, height: 100 });
    g.register(left);
    g.register(right);

    expect(g.targetAt(50, 50)).toBe(left);
    expect(g.targetAt(250, 50)).toBe(right);
    expect(g.targetAt(150, 50)).toBeNull(); // the gap between them
  });

  it('on overlap the geometrically innermost (smallest containing) member wins', () => {
    const g = sortableGroup();
    const outer = member({ top: 0, left: 0, width: 200, height: 200 });
    const inner = member({ top: 50, left: 50, width: 50, height: 50 });
    g.register(outer);
    g.register(inner); // nested → registered after its ancestor

    expect(g.targetAt(75, 75)).toBe(inner); // inside both → inner wins
    expect(g.targetAt(10, 10)).toBe(outer); // only inside outer
  });

  it('resolves innermost by geometry regardless of registration order', () => {
    const g = sortableGroup();
    const outer = member({ top: 0, left: 0, width: 200, height: 200 });
    const inner = member({ top: 50, left: 50, width: 50, height: 50 });
    // register inner FIRST — registration order must not decide the winner
    g.register(inner);
    g.register(outer);
    expect(g.targetAt(75, 75)).toBe(inner); // still inner (smaller rect)
  });

  it('accept filters candidates → innermost ACCEPTED wins (cycle guard)', () => {
    const g = sortableGroup();
    const outer = member({ top: 0, left: 0, width: 200, height: 200 });
    const inner = member({ top: 50, left: 50, width: 50, height: 50 });
    g.register(outer);
    g.register(inner);
    // inner rejected → falls through to the next innermost that accepts
    expect(g.targetAt(75, 75, (m) => m !== inner)).toBe(outer);
    // nothing accepts → null
    expect(g.targetAt(75, 75, () => false)).toBeNull();
  });

  it('skips members that are not yet mounted (null bounds)', () => {
    const g = sortableGroup();
    const unmounted = member(null);
    const mounted = member({ top: 0, left: 0, width: 100, height: 100 });
    g.register(unmounted);
    g.register(mounted);
    expect(g.targetAt(50, 50)).toBe(mounted);
  });

  it('isSortableGroup distinguishes the group object', () => {
    expect(isSortableGroup(sortableGroup())).toBe(true);
    expect(isSortableGroup('cards')).toBe(false);
    expect(isSortableGroup(null)).toBe(false);
  });
});

describe('sortableGroup — index-based register/unregister', () => {
  it('register returns the appended index, and the existing index on re-register', () => {
    const g = sortableGroup();
    const a = member(null);
    const b = member(null);
    const c = member(null);
    expect(g.register(a)).toBe(0);
    expect(g.register(b)).toBe(1);
    expect(g.register(c)).toBe(2);
    expect(g.register(b)).toBe(1); // already present → its current index, no dup
    expect(g.members()).toEqual([a, b, c]);
  });

  it('unregister with a correct index hint removes that member', () => {
    const g = sortableGroup();
    const a = member(null);
    const b = member(null);
    const c = member(null);
    g.register(a);
    const bi = g.register(b);
    g.register(c);
    g.unregister(b, bi);
    expect(g.members()).toEqual([a, c]);
  });

  it('unregister WITHOUT a hint removes the right member, not the last', () => {
    const g = sortableGroup();
    const a = member(null);
    const b = member(null);
    const c = member(null);
    g.register(a);
    g.register(b);
    g.register(c);
    g.unregister(b); // default idx -1 → must look up, not splice(-1) (= last)
    expect(g.members()).toEqual([a, c]);
  });

  it('falls back to lookup when the index hint is stale', () => {
    const g = sortableGroup();
    const a = member(null);
    const b = member(null);
    const c = member(null);
    g.register(a);
    g.register(b);
    const ci = g.register(c); // 2
    g.unregister(a); // now [b, c] → c is at 1, hint 2 is stale
    g.unregister(c, ci);
    expect(g.members()).toEqual([b]);
  });

  it('uses a custom `equal` to identify members (dedup + unregister by identity)', () => {
    type IdMember = SortableGroupMember & { id: number };
    const m = (id: number): IdMember => ({ ...member(null), id });
    const g = sortableGroup({
      equal: (a, b) => (a as IdMember).id === (b as IdMember).id,
    });

    expect(g.register(m(1))).toBe(0);
    expect(g.register(m(1))).toBe(0); // same id, different ref → no duplicate
    expect(g.register(m(2))).toBe(1);

    g.unregister(m(1)); // looked up by id, not reference
    expect(g.members().map((x) => (x as IdMember).id)).toEqual([2]);
  });

  it('public members() is a read-path copy — cannot corrupt the internal registry', () => {
    const g = sortableGroup();
    const a = member({ top: 0, left: 0, width: 10, height: 10 });
    g.register(a);
    expect(g.members()).not.toBe(getGroupInternals(g).members()); // sliced on read
    expect(g.members()).toEqual(getGroupInternals(g).members());
  });
});

describe('sortableGroup — active cross-list drag state', () => {
  it('setActive mirrors into the decomposed signals; clearActive resets them', () => {
    const g = sortableGroup();
    const src = member(null);
    const tgt = member(null);
    const i = getGroupInternals(g);

    expect(i.activeSource()).toBeNull();
    expect(i.activeInsertIndex()).toBe(-1);

    i.setActive({ source: src, target: tgt, sourceIndex: 2, insertIndex: 4, footprint: 30 });
    expect(i.activeSource()).toBe(src);
    expect(i.activeTarget()).toBe(tgt);
    expect(i.activeSourceIndex()).toBe(2);
    expect(i.activeInsertIndex()).toBe(4);
    expect(i.activeFootprint()).toBe(30);

    i.clearActive();
    expect(i.activeSource()).toBeNull();
    expect(i.activeTarget()).toBeNull();
    expect(i.activeInsertIndex()).toBe(-1);
    expect(i.activeFootprint()).toBe(0);
  });
});
