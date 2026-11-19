import { signal } from '@angular/core';

import { getGroupInternals, sortableGroup, type SortableGroup } from './group';
import { reorderable } from './controller';
import type { ReorderableController, ReorderableOptions } from './types';

type Row = { id: string; n?: number };
type Ctrl = ReorderableController<Row, string>;
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
const box = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** A rendered y list at `left`: 20px rows measured at their live index, container 100×200. */
function member(
  group: SortableGroup<Row>,
  left: number,
  start: string[],
  opts: Partial<ReorderableOptions<Row, string>> = {},
  only?: (id: string) => boolean,
) {
  const data = signal(rows(...start));
  const ctrl = reorderable(data, {
    key: (r) => r.id,
    engine: 'pointer',
    group,
    ...opts,
  } as ReorderableOptions<Row, string>) as Ctrl;
  for (const r of data()) {
    if (only && !only(r.id)) continue;
    const el = document.createElement('div');
    const id = r.id;
    el.getBoundingClientRect = () =>
      box(left, data().findIndex((x) => x.id === id) * 20, 100, 20);
    ctrl.register(id, el);
  }
  const container = document.createElement('div');
  container.getBoundingClientRect = () => box(left, 0, 100, 200);
  ctrl.setContainer(container);
  const at = (id: string) =>
    ctrl.itemState(() => data().find((r) => r.id === id) as Row);
  return { data, ctrl, at };
}

/** A at x 0..100, B at x 200..300, one group. */
function pair(
  a: string[] = ['a', 'b', 'c'],
  b: string[] = ['k', 'l'],
  optsA: Partial<ReorderableOptions<Row, string>> = {},
  optsB: Partial<ReorderableOptions<Row, string>> = {},
) {
  const group = sortableGroup<Row>();
  const A = member(group, 0, a, optsA);
  const B = member(group, 200, b, optsB);
  return { group, gi: getGroupInternals(group), A, B };
}

describe('cross-list drag: what the source hands the target', () => {
  it('a grouped row follows the pointer in 2D from where it was grabbed', () => {
    const { A } = pair();
    A.ctrl.beginGesture('b', { x: 50, y: 30 });
    A.ctrl.move({ x: 50, y: 60 });
    expect(A.at('b').transformCss()).toBe('translate(0px, 30px)');
    A.ctrl.move({ x: 80, y: 30 });
    expect(A.at('b').transformCss()).toBe('translate(30px, 0px)');
  });

  it('the target opens the measured footprint of the dragged row', () => {
    const { A, B, gi } = pair();
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 15 });
    expect(gi.activeFootprint()).toBe(20);
    expect(B.at('k').transform()).toBe(0);
    expect(B.at('l').transform()).toBe(20);
  });

  it('a lone row hands over its own size', () => {
    const { A, B } = pair(['m']);
    A.ctrl.beginGesture('m', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 15 });
    expect(B.at('l').transform()).toBe(20);
  });

  it('dragging a later row closes only the rows after it, by its live index', () => {
    const { A, gi } = pair();
    A.ctrl.beginGesture('c', { x: 50, y: 50 });
    A.ctrl.move({ x: 250, y: 15 });
    expect(gi.activeSourceIndex()).toBe(2);
    expect(A.at('a').transform()).toBe(0);
    expect(A.at('b').transform()).toBe(0);
  });

  it('an x list maps its main/cross to the right viewport axes for a point drop', () => {
    const group = sortableGroup<Row>();
    const A = member(group, 0, ['a', 'b'], { axis: 'x' });
    const insertAtPoint = vi.fn(() => true);
    group.register({
      bounds: () => box(200, 0, 100, 100),
      refreshBounds: () => undefined,
      measure: () => ({ centers: [], axis: 'y' }),
      insertAt: () => false,
      insertAtPoint,
    });
    A.ctrl.beginGesture('a', { x: 10, y: 10 });
    A.ctrl.move({ x: 250, y: 50 });
    A.ctrl.end();
    expect(insertAtPoint).toHaveBeenCalledWith({ id: 'a' }, 250, 50);
  });

  it('a consumed point drop moves the item out of the source exactly once', () => {
    const onItemLeft = vi.fn();
    const { group, A } = pair(['a', 'b'], [], { onItemLeft });
    const insertAtPoint = vi.fn(() => true);
    group.register({
      bounds: () => box(400, 0, 100, 100),
      refreshBounds: () => undefined,
      measure: () => ({ centers: [], axis: 'y' }),
      insertAt: () => false,
      insertAtPoint,
    });
    A.ctrl.beginGesture('a', { x: 10, y: 10 });
    A.ctrl.move({ x: 450, y: 50 });
    A.ctrl.end();
    expect(insertAtPoint).toHaveBeenCalledWith({ id: 'a' }, 450, 50);
    expect(ids(A.data())).toEqual(['b']);
    expect(onItemLeft).toHaveBeenCalledTimes(1);
  });

  it('a member without slotOfAnchor gets the raw insert index', () => {
    const { group, A } = pair(['a', 'b'], []);
    const insertAt = vi.fn(() => true);
    group.register({
      bounds: () => box(400, 0, 100, 100),
      refreshBounds: () => undefined,
      measure: () => ({ centers: [10, 30], axis: 'y', keys: ['p', 'q'] }),
      insertAt,
    });
    A.ctrl.beginGesture('a', { x: 10, y: 10 });
    A.ctrl.move({ x: 450, y: 25 });
    expect(() => A.ctrl.end()).not.toThrow();
    expect(insertAt).toHaveBeenCalledWith({ id: 'a' }, 1);
  });

  it('a hover above the first row drops at slot 0', () => {
    const { A, B } = pair();
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 2 });
    A.ctrl.end();
    expect(ids(B.data())).toEqual(['a', 'k', 'l']);
  });

  it('a target with a row that is not rendered measures empty: insert 0, no throw', () => {
    const group = sortableGroup<Row>();
    const A = member(group, 0, ['a']);
    member(group, 200, ['k', 'l'], {}, (id) => id === 'k');
    const gi = getGroupInternals(group);
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    expect(() => A.ctrl.move({ x: 250, y: 35 })).not.toThrow();
    expect(gi.activeInsertIndex()).toBe(0);
  });
});

describe('cross-list drag: the receive guard', () => {
  it.each([
    ['refuses', false, ['a', 'b', 'c'], ['k', 'l']],
    ['accepts', true, ['b', 'c'], ['k', 'a', 'l']],
  ])('canReceive %s', (_name, ok, endA, endB) => {
    const canReceive = vi.fn(() => ok);
    const { A, B, gi } = pair(undefined, undefined, {}, { canReceive });
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 25 });
    expect(canReceive).toHaveBeenCalledWith({ id: 'a' });
    expect(gi.activeTarget() === B.ctrl).toBe(ok);
    A.ctrl.end();
    expect(ids(A.data())).toEqual(endA);
    expect(ids(B.data())).toEqual(endB);
  });

  it('the own list always takes its row back, even if its canReceive refuses', () => {
    const { A, B, gi } = pair(undefined, undefined, {
      canReceive: () => false,
    });
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 25 });
    expect(gi.activeTarget()).toBe(B.ctrl);
    A.ctrl.move({ x: 50, y: 55 });
    expect(gi.activeTarget()).toBeNull();
    expect(B.at('l').transform()).toBe(0);
    A.ctrl.end();
    expect(ids(A.data())).toEqual(['b', 'c', 'a']);
    expect(ids(B.data())).toEqual(['k', 'l']);
  });

  it('a dragged row removed by another writer drives no list before the render pass, and never reaches canReceive', () => {
    const canReceive = vi.fn(() => true);
    const { A, B, gi } = pair(undefined, undefined, {}, { canReceive });
    A.ctrl.beginGesture('b', { x: 50, y: 30 });
    A.data.update((arr) => arr.filter((r) => r.id !== 'b'));
    A.ctrl.move({ x: 250, y: 25 });
    expect(canReceive).not.toHaveBeenCalled();
    expect(gi.activeSource()).toBeNull();
    expect(A.at('c').transform()).toBe(0);
    expect(B.at('l').transform()).toBe(0);
  });

  it('after a drag is abandoned, further moves drive no sibling list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { A, B, gi } = pair();
      A.ctrl.beginGesture('b', { x: 50, y: 30 });
      A.data.update((arr) => arr.filter((r) => r.id !== 'b'));
      A.ctrl.syncGeometry();
      A.ctrl.move({ x: 250, y: 25 });
      expect(gi.activeSource()).toBeNull();
      expect(B.at('l').transform()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('group membership and the pure begin()', () => {
  it('a list whose container is recreated rejoins its group', () => {
    const group = sortableGroup<Row>();
    const ctrl = reorderable(signal(rows('a')), { key: (r) => r.id, group });
    expect(group.members()).toContain(ctrl);
    ctrl.dispose();
    expect(group.members()).not.toContain(ctrl);
    ctrl.setContainer(document.createElement('div'));
    ctrl.setContainer(document.createElement('div'));
    expect(group.members().filter((m) => m === ctrl)).toHaveLength(1);
  });

  it('begin() takes the cross-axis start, so a grouped row follows from where it was grabbed', () => {
    const { A } = pair();
    A.ctrl.begin(
      'b',
      { source: 1, centers: [10, 30, 50], footprint: 20, axis: 'y' },
      30,
      50,
    );
    A.ctrl.move({ x: 50, y: 60 });
    expect(A.at('b').transformCss()).toBe('translate(0px, 30px)');
  });

  it('every begin() measures a hovered target afresh', () => {
    const { group, gi, A } = pair(['a', 'b'], []);
    let centers = [10];
    group.register({
      bounds: () => box(400, 0, 100, 100),
      refreshBounds: () => undefined,
      measure: () => ({ centers, axis: 'y' as const }),
      insertAt: () => true,
    });
    const g = {
      source: 0,
      centers: [10, 30],
      footprint: 20,
      axis: 'y' as const,
    };
    A.ctrl.begin('a', g, 10, 50);
    A.ctrl.move({ x: 450, y: 20 });
    expect(gi.activeInsertIndex()).toBe(1);
    A.ctrl.cancel();
    centers = [30];
    A.ctrl.begin('a', g, 10, 50);
    A.ctrl.move({ x: 450, y: 20 });
    expect(gi.activeInsertIndex()).toBe(0);
  });
});

describe('group roles: source, target, bystander', () => {
  it('a bystander list neither opens, closes, reserves nor glides', () => {
    const { group, gi, A, B } = pair();
    const C = member(group, 400, ['p', 'q']);
    gi.setActive({
      source: A.ctrl,
      target: B.ctrl,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 20,
    });
    expect(C.at('q').transform()).toBe(0);
    expect(C.ctrl.reservedSpace()).toBe(0);
    expect(C.at('q').transitionCss()).toBe('none');
    expect(B.at('l').transitionCss()).toContain('transform');
    expect(B.ctrl.reservedSpace()).toBe(20);
    expect(A.ctrl.reservedSpace()).toBe(0);
  });

  it('an empty target reserves nothing (its min-height is the slot)', () => {
    const { gi, A, B } = pair(['a'], []);
    gi.setActive({
      source: A.ctrl,
      target: B.ctrl,
      sourceIndex: 0,
      insertIndex: 0,
      footprint: 30,
    });
    expect(B.ctrl.reservedSpace()).toBe(0);
  });

  it('a same-list drag in a grouped list still opens its own gap', () => {
    const { A } = pair();
    A.ctrl.begin(
      'a',
      { source: 0, centers: [10, 30, 50], footprint: 20, axis: 'y' },
      10,
      50,
    );
    A.ctrl.move({ x: 50, y: 35 });
    expect(A.at('b').transform()).toBe(-20);
  });

  it('disposing a bystander mid-drag leaves the cross-list drag intact', () => {
    const { group, gi, A, B } = pair();
    const C = member(group, 400, ['p']);
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 25 });
    C.ctrl.dispose();
    expect(gi.activeSource()).toBe(A.ctrl);
    A.ctrl.end();
    expect(ids(B.data())).toEqual(['k', 'a', 'l']);
  });
});

describe('transfer bookkeeping', () => {
  it('insertAt clamps a far index and names the arrival by its neighbour', () => {
    const onItemArrived = vi.fn();
    const group = sortableGroup<Row>();
    const B = reorderable(signal(rows('k', 'l')), {
      key: (r) => r.id,
      group,
      onItemArrived,
    });
    B.insertAt({ id: 'z' }, 99);
    expect(onItemArrived.mock.calls[0][0]).toMatchObject({
      moved: 'z',
      anchor: { after: 'l' },
    });
  });

  it('an arrival whose key repeats a row the list never read keeps the handles continuous', () => {
    const onItemArrived = vi.fn();
    const B = reorderable(signal<Row[]>([{ id: 'a' }]), {
      key: (r) => r.id,
      onItemArrived,
    });
    B.insertAt({ id: 'a', n: 3 }, 0);
    expect(onItemArrived.mock.calls[0][0].anchor).toEqual({ before: 'a' });
  });

  it('anchorFor is null for an item not in the list', () => {
    const B = reorderable(signal(rows('k')), { key: (r) => r.id });
    expect(B.anchorFor?.({ id: 'zz' })).toBeNull();
  });

  it('a drop at the front gives onItemLeft a before-anchor', () => {
    const onItemLeft = vi.fn();
    const { A } = pair(undefined, undefined, { onItemLeft });
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 2 });
    A.ctrl.end();
    expect(onItemLeft.mock.calls[0][0].anchor).toEqual({ before: 'k' });
  });

  it('a transfer the target already applied takes nothing else out of the source', () => {
    const onItemLeft = vi.fn();
    const group = sortableGroup<Row>();
    const A = member(group, 0, ['a', 'b', 'c'], { onItemLeft });
    member(group, 200, ['k'], {
      onItemArrived: ({ moved }) =>
        A.data.update((arr) => arr.filter((r) => r.id !== moved)),
    });
    A.ctrl.beginGesture('a', { x: 50, y: 10 });
    A.ctrl.move({ x: 250, y: 15 });
    A.ctrl.end();
    expect(ids(A.data())).toEqual(['b', 'c']);
    expect(onItemLeft).not.toHaveBeenCalled();
  });

  it('a list with insert but no onItemInserted maps a foreign payload without throwing', () => {
    const data = signal(rows('a'));
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      insert: { accepts: () => true, create: (d) => ({ id: String(d) }) },
    });
    expect(() => ctrl.insertForeign('x', 0)).not.toThrow();
    expect(ids(data())).toEqual(['x', 'a']);
  });

  it('a same-list commit names the moved occurrence by the handle it had before a fresh write', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const data = signal<Row[]>([a1, a2]);
    const onReorder = vi.fn();
    const ctrl = reorderable(data, { key: (r) => r.id, onReorder });
    const before = [...ctrl.indexMap().entries()];
    const first = before.find(([, i]) => i === 0)?.[0];
    data.set([{ ...a1 }, { ...a2 }]);
    ctrl.moveItem(0, 1);
    expect(onReorder.mock.calls[0][0].moved).toBe(first);
  });
});
