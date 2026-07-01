import { signal } from '@angular/core';
import { getGroupInternals, sortableGroup } from './group';
import { type DragGeometry } from './session';
import { reorderable } from './reorderable';

type Task = { id: number; label: string };

const DATA: Task[] = [
  { id: 1, label: 'a' },
  { id: 2, label: 'b' },
  { id: 3, label: 'c' },
  { id: 4, label: 'd' },
  { id: 5, label: 'e' },
];

// geometry as it would be measured for a 5-item vertical list (centers 10..90, size 20)
const geom = (source: number): DragGeometry => ({
  source,
  centers: [10, 30, 50, 70, 90],
  footprint: 20,
  axis: 'y',
});

/**
 * The controller is the testable "world": no TestBed, no component render — just
 * drive begin/move/end and read the per-item state signals.
 */
describe('reorderable controller — itemState (pure, no DOM/render)', () => {
  it('derives index / isSource / transform without rendering', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });

    const item2 = ctrl.itemState(() => data()[2]); // id 3
    expect(item2.index()).toBe(2);
    expect(item2.isSource()).toBe(false);
    expect(item2.transform()).toBe(0);
    expect(item2.transformCss()).toBe('');

    ctrl.begin(DATA[0].id, geom(0), 10); // drag id 1 from its center
    ctrl.move({ x: 0, y: 55 }); // past the center of item 2 → insert 2

    expect(ctrl.insertIndex()).toBe(2);
    expect(item2.isSource()).toBe(false);
    expect(item2.transform()).toBe(-20); // displaced up to fill the gap
    expect(item2.transformCss()).toBe('translateY(-20px)');
    expect(item2.transitionCss()).toContain('--mm-sortable-easing'); // expressive spring (overridable)
  });

  it('the source follows the pointer (delta), with no transition', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });

    const item0 = ctrl.itemState(() => data()[0]);
    ctrl.begin(DATA[0].id, geom(0), 10);
    ctrl.move({ x: 0, y: 34 }); // delta +24

    expect(item0.isSource()).toBe(true);
    expect(item0.transform()).toBe(24);
    expect(item0.transformCss()).toBe('translateY(24px)');
    expect(item0.transitionCss()).toBe('none');
  });

  it('commits the reorder on end and resets all item transforms', () => {
    const data = signal(DATA.slice());
    const reorders: Array<{ from: number; to: number }> = [];
    const ctrl = reorderable(data, {
      key: (t) => t.id,
      onReorder: ({ from, to }) => reorders.push({ from, to }),
    });

    const item2 = ctrl.itemState(() => data()[2]);
    ctrl.begin(DATA[0].id, geom(0), 10);
    ctrl.move({ x: 0, y: 55 });
    ctrl.end();

    expect(data().map((t) => t.id)).toEqual([2, 3, 1, 4, 5]); // moveWithin(0 → 2)
    expect(reorders).toEqual([{ from: 0, to: 2 }]);
    expect(ctrl.insertIndex()).toBe(-1);
    expect(item2.transform()).toBe(0);
    expect(ctrl.activeKey()).toBeNull();
  });

  it('moveItem (keyboard reorder) commits a same-list move + onReorder, with guards', () => {
    const data = signal(DATA.slice());
    const reorders: Array<{ from: number; to: number }> = [];
    const ctrl = reorderable(data, {
      key: (t) => t.id,
      onReorder: ({ from, to }) => reorders.push({ from, to }),
    });

    ctrl.moveItem(0, 2);
    expect(data().map((t) => t.id)).toEqual([2, 3, 1, 4, 5]);
    expect(reorders).toEqual([{ from: 0, to: 2 }]);

    ctrl.moveItem(1, 1); // same index → no-op
    ctrl.moveItem(-1, 0); // invalid → no-op
    expect(reorders).toHaveLength(1);
  });

  it('keyboard defaults: enabled, with a sensible announce message', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });
    expect(ctrl.keyboard).toBe(true);
    expect(ctrl.announceMove).not.toBeNull();
    expect(
      ctrl.announceMove?.({ item: DATA[0], from: 0, to: 2, total: 5 }),
    ).toBe('Moved to position 3 of 5');
  });

  it('announceMove: false resolves the controller message to null (a11y opt-out)', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id, announceMove: false });
    expect(ctrl.announceMove).toBeNull();
  });

  it('a drag that ends at the source index commits nothing', () => {
    const data = signal(DATA.slice());
    let fired = false;
    const ctrl = reorderable(data, {
      key: (t) => t.id,
      onReorder: () => (fired = true),
    });

    ctrl.begin(DATA[0].id, geom(0), 10);
    ctrl.move({ x: 0, y: 12 }); // stays within slot 0
    ctrl.end();

    expect(data().map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fired).toBe(false);
  });
});

describe('reorderable controller — cross-list (group, no DOM/render)', () => {
  const A = (): Task[] => [
    { id: 1, label: 'a1' },
    { id: 2, label: 'a2' },
    { id: 3, label: 'a3' },
  ];
  const B = (): Task[] => [
    { id: 11, label: 'b1' },
    { id: 12, label: 'b2' },
  ];

  it('roles: the source list closes, the target list opens', () => {
    const a = signal(A());
    const b = signal(B());
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, { key: (t) => t.id, group });
    const ctrlB = reorderable(b, { key: (t) => t.id, group });
    const gi = getGroupInternals(group);

    // simulate: A's item 0 is being dragged into B at index 1, footprint 50
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 50,
    });

    // source A closes behind the departed item 0 → items 1,2 shift back
    expect(ctrlA.itemState(() => a()[1]).transform()).toBe(-50);
    expect(ctrlA.itemState(() => a()[2]).transform()).toBe(-50);
    // target B opens at insert 1 → item 0 stays, item 1 shifts forward
    expect(ctrlB.itemState(() => b()[0]).transform()).toBe(0);
    expect(ctrlB.itemState(() => b()[1]).transform()).toBe(50);
  });

  it('commit: end() transfers the item across the lists and fires both callbacks', () => {
    const a = signal(A());
    const b = signal(B());
    const left: Array<{ item: Task; from: number; to: number }> = [];
    const arrived: Array<{ item: Task; index: number }> = [];
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, {
      key: (t) => t.id,
      group,
      onItemLeft: (e) => left.push(e),
    });
    const ctrlB = reorderable(b, {
      key: (t) => t.id,
      group,
      onItemArrived: (e) => arrived.push(e),
    });
    const gi = getGroupInternals(group);

    ctrlA.begin(1, { source: 0, centers: [0, 30, 60], footprint: 30, axis: 'y' }, 0);
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 30,
    });
    ctrlA.end();

    expect(a().map((t) => t.id)).toEqual([2, 3]); // a1 removed from A
    expect(b().map((t) => t.id)).toEqual([11, 1, 12]); // a1 inserted into B at 1
    expect(left).toEqual([{ item: { id: 1, label: 'a1' }, from: 0, to: 1 }]);
    expect(arrived).toEqual([{ item: { id: 1, label: 'a1' }, index: 1 }]);
    expect(gi.activeSource()).toBeNull(); // active cleared on end
  });

  it('a same-list drop in a grouped list still reorders (no transfer)', () => {
    const a = signal(A());
    const b = signal(B());
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, { key: (t) => t.id, group });
    reorderable(b, { key: (t) => t.id, group });

    // drag within A: source 0 → insert 2 (target stays self → same-list path)
    ctrlA.begin(1, { source: 0, centers: [10, 30, 50], footprint: 20, axis: 'y' }, 10);
    ctrlA.move({ x: 0, y: 55 });
    ctrlA.end();

    expect(a().map((t) => t.id)).toEqual([2, 3, 1]); // reordered within A
    expect(b().map((t) => t.id)).toEqual([11, 12]); // B untouched
  });

  it('dispose() mid-drag tears down the in-flight drag (clears activeKey + the group active slot)', () => {
    const a = signal(A());
    const b = signal(B());
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, { key: (t) => t.id, group });
    const ctrlB = reorderable(b, { key: (t) => t.id, group });
    const gi = getGroupInternals(group);

    // A's item 0 is being dragged toward B when A's view is destroyed
    ctrlA.begin(1, { source: 0, centers: [0, 30, 60], footprint: 30, axis: 'y' }, 0);
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 30,
    });
    expect(ctrlA.activeKey()).toBe(1);
    expect(gi.activeSource()).toBe(ctrlA);

    ctrlA.dispose();

    expect(ctrlA.activeKey()).toBeNull(); // in-flight drag torn down, no commit
    expect(gi.activeSource()).toBeNull(); // sibling lists no longer driven by a dead source
    expect(a().map((t) => t.id)).toEqual([1, 2, 3]); // nothing committed
    expect(b().map((t) => t.id)).toEqual([11, 12]);
  });
});

/**
 * Regression guards for the perf/teardown discipline the code already follows —
 * they don't test new behaviour, they pin it so a future edit can't silently
 * reintroduce per-frame layout reads or a registry leak.
 */
describe('reorderable controller — perf / teardown guards', () => {
  const register = (ctrl: ReturnType<typeof reorderable<Task, number>>) =>
    DATA.map((t) => {
      const el = document.createElement('div');
      ctrl.register(t.id, el);
      return el;
    });

  it('measures item geometry ONCE at gesture start, never per pointer frame (frozen)', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });
    register(ctrl);

    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    ctrl.beginGesture(DATA[0].id, { x: 0, y: 10 });
    const afterBegin = rect.mock.calls.length;
    expect(afterBegin).toBe(DATA.length); // one rect read per item, in source order
    expect(ctrl.activeKey()).toBe(DATA[0].id); // gesture is live

    for (let y = 12; y < 90; y += 5) ctrl.move({ x: 0, y }); // ~15 frames of movement
    expect(rect.mock.calls.length).toBe(afterBegin); // ...with ZERO extra layout reads
    rect.mockRestore();
  });

  it('unregister drains the registry (no stale entries after items destroy)', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });
    const nodes = register(ctrl);

    nodes.forEach((el, i) => expect(ctrl.keyForElement(el)).toBe(DATA[i].id));
    DATA.forEach((t, i) => ctrl.unregister(t.id, nodes[i]));

    // byEl fully drained
    nodes.forEach((el) => expect(ctrl.keyForElement(el)).toBeUndefined());
    // byKey drained too: a gesture can't find a node → bails, no drag starts
    ctrl.beginGesture(DATA[0].id, { x: 0, y: 10 });
    expect(ctrl.activeKey()).toBeNull();
  });

  it('unregister is identity-guarded (a stale element cannot evict a re-registered key)', () => {
    const data = signal(DATA.slice());
    const ctrl = reorderable(data, { key: (t) => t.id });
    const first = document.createElement('div');
    const second = document.createElement('div');

    ctrl.register(DATA[0].id, first);
    ctrl.register(DATA[0].id, second); // key re-bound to a fresh node
    ctrl.unregister(DATA[0].id, first); // stale teardown must be a no-op

    expect(ctrl.keyForElement(second)).toBe(DATA[0].id); // live binding survives
  });
});
