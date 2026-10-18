import { signal } from '@angular/core';
import { type Handle, isKeyHandle } from '@mmstack/primitives';
import { getGroupInternals, sortableGroup } from './group';
import { type DragGeometry } from './session';
import { reorderable } from './reorderable';
import { type ListAnchor, slotAnchor } from './geometry';
import { commitNativeDrop } from './native';

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

  it('cancel() aborts the drag without committing (Escape / pointercancel path)', () => {
    const data = signal(DATA.slice());
    let fired = false;
    const ctrl = reorderable(data, {
      key: (t) => t.id,
      onReorder: () => (fired = true),
    });
    const item2 = ctrl.itemState(() => data()[2]);

    ctrl.begin(DATA[0].id, geom(0), 10);
    ctrl.move({ x: 0, y: 55 }); // insert 2 — a commit would reorder
    ctrl.cancel();

    expect(data().map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fired).toBe(false);
    expect(ctrl.activeKey()).toBeNull();
    expect(ctrl.insertIndex()).toBe(-1);
    expect(item2.transform()).toBe(0);
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
    expect(left).toMatchObject([
      { item: { id: 1, label: 'a1' }, from: 0, to: 1 },
    ]);
    expect(arrived).toMatchObject([{ item: { id: 1, label: 'a1' }, index: 1 }]);
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

  it('an invalid cross-list commit is a no-op — never a fallback same-list move', () => {
    const a = signal(A());
    const b = signal(B());
    let reordered = false;
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, {
      key: (t) => t.id,
      group,
      onReorder: () => (reordered = true),
    });
    const ctrlB = reorderable(b, { key: (t) => t.id, group });
    const gi = getGroupInternals(group);

    // drag within A far enough that a same-list commit WOULD move it...
    ctrlA.begin(1, { source: 0, centers: [10, 30, 50], footprint: 20, axis: 'y' }, 10);
    ctrlA.move({ x: 0, y: 55 });
    // ...but the drag ends over B with an unresolvable insert
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: -1,
      footprint: 20,
    });
    ctrlA.end();

    expect(a().map((t) => t.id)).toEqual([1, 2, 3]); // no sneaky same-list reorder
    expect(b().map((t) => t.id)).toEqual([11, 12]);
    expect(reordered).toBe(false);
  });

  it('cancel() mid-cross-list-drag releases the sibling lists (no transfer)', () => {
    const a = signal(A());
    const b = signal(B());
    const group = sortableGroup<Task>();
    const ctrlA = reorderable(a, { key: (t) => t.id, group });
    const ctrlB = reorderable(b, { key: (t) => t.id, group });
    const gi = getGroupInternals(group);

    ctrlA.begin(1, { source: 0, centers: [0, 30, 60], footprint: 30, axis: 'y' }, 0);
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 30,
    });

    ctrlA.cancel();

    expect(gi.activeSource()).toBeNull();
    expect(a().map((t) => t.id)).toEqual([1, 2, 3]);
    expect(b().map((t) => t.id)).toEqual([11, 12]);
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

/**
 * [PIN M4] The dragged item is its KEY, resolved through the live index at every
 * decision — never the slot it held when the drag began. A peer write mid-drag
 * (another tab, an agent, a resource refresh) must not hand the drop to a bystander.
 */
describe('reorderable controller — drag identity is the live key [PIN M4]', () => {
  type Row = { id: string };
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
  const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
  const ROW = 20;

  /** A rendered list: every registered row measures at its LIVE index (a re-rendered DOM). */
  function render(
    ctrl: ReturnType<typeof reorderable<Row, string>>,
    data: () => Row[],
  ) {
    const els = new Map<string, HTMLElement>();
    const sync = () => {
      for (const r of data()) {
        if (els.has(r.id)) continue;
        const el = document.createElement('div');
        const id = r.id;
        el.getBoundingClientRect = () => {
          const i = data().findIndex((x) => x.id === id);
          return {
            top: i * ROW,
            bottom: i * ROW + ROW,
            left: 0,
            right: 100,
            width: 100,
            height: ROW,
            x: 0,
            y: i * ROW,
            toJSON: () => ({}),
          } as DOMRect;
        };
        ctrl.register(id, el);
        els.set(id, el);
      }
    };
    sync();
    return { els, sync };
  }

  function list(...start: string[]) {
    const data = signal(rows(...start));
    const reorders: Array<{ from: number; to: number }> = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      engine: 'pointer',
      onReorder: ({ from, to }) => reorders.push({ from, to }),
    });
    return { data, ctrl, reorders, dom: render(ctrl, data) };
  }

  it('a prepend mid-drag, then a same-list drop, moves the dragged key (not the row one slot over)', () => {
    const { data, ctrl, reorders, dom } = list('a', 'b', 'c', 'd');
    ctrl.beginGesture('b', { x: 0, y: 30 }); // b's center
    ctrl.move({ x: 0, y: 95 }); // past d → b goes last
    expect(ctrl.insertIndex()).toBe(3);

    data.update((arr) => [{ id: 'x' }, ...arr]); // peer prepend
    dom.sync(); // x renders
    ctrl.syncGeometry(); // the render pass re-measures (pointer.ts afterRenderEffect)
    ctrl.end();

    expect(ids(data())).toEqual(['x', 'a', 'c', 'd', 'b']);
    expect(reorders).toEqual([{ from: 2, to: 4 }]); // from = b's LIVE index
    expect(ctrl.activeKey()).toBeNull();
  });

  it('re-measures after a mid-drag key change: the gap and the follow are read from the live list', () => {
    const { data, ctrl, dom } = list('a', 'b', 'c', 'd');
    ctrl.beginGesture('b', { x: 0, y: 30 });
    ctrl.move({ x: 0, y: 95 });

    data.update((arr) => [{ id: 'x' }, ...arr]);
    dom.sync();
    ctrl.syncGeometry();

    const at = (id: string) =>
      ctrl.itemState(() => data().find((r) => r.id === id) as Row);
    // b now rests at 40..60 (center 50): it still sits under the pointer at 95
    expect(at('b').transform()).toBe(45);
    expect(at('x').transform()).toBe(0);
    expect(at('a').transform()).toBe(0);
    expect(at('c').transform()).toBe(-ROW); // closing b's hole
    expect(at('d').transform()).toBe(-ROW);
    expect(ctrl.insertIndex()).toBe(4);
  });

  it('re-measures the layout position, not the visual one: a displaced sibling has its transform subtracted', () => {
    const { data, ctrl, dom } = list('a', 'b', 'c', 'd');
    ctrl.beginGesture('b', { x: 0, y: 30 });
    data.update((arr) => [{ id: 'x' }, ...arr]);
    dom.sync();
    // c is mid-glide 20px above its layout slot (60..80 → renders at 40..60)
    const c = dom.els.get('c') as HTMLElement;
    c.style.transform = 'translateY(-20px)';
    const layout = c.getBoundingClientRect.bind(c);
    c.getBoundingClientRect = () => {
      const r = layout();
      return {
        ...r,
        top: r.top - ROW,
        bottom: r.bottom - ROW,
        y: r.y - ROW,
      } as DOMRect;
    };
    ctrl.syncGeometry();
    ctrl.move({ x: 0, y: 65 }); // before c's LAYOUT center (70), past its visual one (50)
    expect(ctrl.insertIndex()).toBe(2); // [x, a, b, c, d]: b stays put
  });

  it('a cross-list drop after a prepend transfers the dragged key', () => {
    const a = signal(rows('a', 'b', 'c'));
    const b = signal(rows('k', 'l'));
    const left: Array<{ item: Row; from: number; to: number }> = [];
    const group = sortableGroup<Row>();
    const ctrlA = reorderable(a, {
      key: (r) => r.id,
      group,
      onItemLeft: (e) => left.push(e),
    });
    const ctrlB = reorderable(b, { key: (r) => r.id, group });
    const gi = getGroupInternals(group);

    ctrlA.begin(
      'b',
      { source: 1, centers: [10, 30, 50], footprint: 20, axis: 'y' },
      30,
    );
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 1,
      insertIndex: 1,
      footprint: 20,
    });
    a.update((arr) => [{ id: 'x' }, ...arr]); // peer prepend in the SOURCE list
    ctrlA.end();

    expect(ids(a())).toEqual(['x', 'a', 'c']);
    expect(ids(b())).toEqual(['k', 'b', 'l']);
    expect(left).toMatchObject([{ item: { id: 'b' }, from: 2, to: 1 }]);
  });

  it('the dragged item removed mid-drag: the same-list drop is a no-op (no bystander moves, no event), loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { data, ctrl, reorders } = list('a', 'b', 'c', 'd');
      ctrl.beginGesture('b', { x: 0, y: 30 });
      ctrl.move({ x: 0, y: 95 });
      data.update((arr) => arr.filter((r) => r.id !== 'b'));
      const before = data();
      ctrl.end();

      expect(data()).toBe(before); // no write at all
      expect(ids(data())).toEqual(['a', 'c', 'd']);
      expect(reorders).toEqual([]);
      expect(ctrl.activeKey()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('removed');
    } finally {
      warn.mockRestore();
    }
  });

  it('the dragged item removed mid-drag: a cross-list drop is a no-op too', () => {
    const a = signal(rows('a', 'b', 'c'));
    const b = signal(rows('k', 'l'));
    let events = 0;
    const group = sortableGroup<Row>();
    const ctrlA = reorderable(a, {
      key: (r) => r.id,
      group,
      onItemLeft: () => events++,
    });
    const ctrlB = reorderable(b, {
      key: (r) => r.id,
      group,
      onItemArrived: () => events++,
    });
    const gi = getGroupInternals(group);

    ctrlA.begin(
      'b',
      { source: 1, centers: [10, 30, 50], footprint: 20, axis: 'y' },
      30,
    );
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 1,
      insertIndex: 1,
      footprint: 20,
    });
    a.update((arr) => arr.filter((r) => r.id !== 'b'));
    ctrlA.end();

    expect(ids(a())).toEqual(['a', 'c']);
    expect(ids(b())).toEqual(['k', 'l']);
    expect(events).toBe(0);
    expect(gi.activeSource()).toBeNull();
  });

  it('a key change it cannot measure (a new row not rendered yet) cancels the drop loudly, never a stale commit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { data, ctrl, reorders } = list('a', 'b', 'c', 'd');
      ctrl.beginGesture('b', { x: 0, y: 30 });
      ctrl.move({ x: 0, y: 95 });
      data.update((arr) => [{ id: 'x' }, ...arr]); // x never renders
      ctrl.end();

      expect(ids(data())).toEqual(['x', 'a', 'b', 'c', 'd']);
      expect(reorders).toEqual([]);
      expect(ctrl.activeKey()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a drop never measures: a key change that has not rendered yet abandons the drop, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { data, ctrl, reorders } = list('a', 'b', 'c');
      ctrl.beginGesture('a', { x: 0, y: 10 });
      ctrl.move({ x: 0, y: 55 });
      // a peer reorders; every row is still registered, but the DOM still shows the old order
      data.update((arr) => [arr[2], arr[0], arr[1]]);
      const before = data();
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
      ctrl.end();
      expect(rect).not.toHaveBeenCalled(); // no measurement from the drop path
      rect.mockRestore();

      expect(data()).toBe(before); // no write
      expect(reorders).toEqual([]);
      expect(ctrl.activeKey()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('not rendered');
    } finally {
      warn.mockRestore();
    }
  });

  it('a write that keeps the key sequence (an edit in place) re-measures nothing', () => {
    const { data, ctrl, reorders } = list('a', 'b', 'c', 'd');
    ctrl.beginGesture('b', { x: 0, y: 30 });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    data.update((arr) => arr.map((r) => ({ ...r }))); // fresh objects, same keys, same order
    ctrl.syncGeometry();
    ctrl.move({ x: 0, y: 95 });
    ctrl.end();
    expect(rect).not.toHaveBeenCalled();
    rect.mockRestore();
    expect(ids(data())).toEqual(['a', 'c', 'd', 'b']);
    expect(reorders).toEqual([{ from: 1, to: 3 }]);
  });
});

/**
 * [PIN M7] Every drop event names where the item landed by a neighbour key, so a
 * consumer that applies the move later (a mesh write, an undo stack) lands it in
 * the same place even if the list changed in between. `from`/`to` are unchanged.
 */
describe('reorderable controller — drop events carry a neighbour anchor [PIN M7]', () => {
  type Row = { id: string };
  // events carry handles: the raw key here, since no key is duplicated
  type Anchor = ListAnchor<Handle<string>>;
  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
  const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
  /** What a consumer does with the anchor: seat `moved` next to its neighbour in WHATEVER list it has now. */
  const applyAnchor = (
    keys: string[],
    moved: Handle<string>,
    anchor: Anchor,
  ): string[] => {
    const rest = keys.filter((k) => k !== moved);
    const at =
      'after' in anchor
        ? rest.indexOf(anchor.after as string) + 1
        : 'before' in anchor
          ? rest.indexOf(anchor.before as string)
          : 0;
    rest.splice(at, 0, moved as string);
    return rest;
  };

  it('onReorder: the anchor resolves to the right place after a concurrent insert between the neighbours', () => {
    const data = signal(rows('a', 'b', 'c', 'd'));
    const events: Array<{
      from: number;
      to: number;
      moved: Handle<string>;
      anchor: Anchor;
    }> = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ from, to, moved, anchor }) =>
        events.push({ from, to, moved, anchor }),
    });
    ctrl.moveItem(0, 2); // a between c and d: [b, c, a, d]
    expect(events).toEqual([
      { from: 0, to: 2, moved: 'a', anchor: { after: 'c' } },
    ]);

    // a peer's copy of the list got x between b and c before it applies our move
    const peer = ['a', 'b', 'x', 'c', 'd'];
    const { moved, anchor, to } = events[0];
    expect(applyAnchor(peer, moved, anchor)).toEqual(['b', 'x', 'c', 'a', 'd']); // a after c
    const byIndex = peer.filter((k) => k !== moved);
    byIndex.splice(to, 0, moved as string);
    expect(byIndex).toEqual(['b', 'x', 'a', 'c', 'd']); // the index lands it before c: wrong
  });

  it('onReorder from a pointer drop carries the anchor too', () => {
    const data = signal(rows('a', 'b', 'c', 'd', 'e'));
    const anchors: Anchor[] = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ anchor }) => anchors.push(anchor),
    });
    ctrl.begin(
      'a',
      { source: 0, centers: [10, 30, 50, 70, 90], footprint: 20, axis: 'y' },
      10,
    );
    ctrl.move({ x: 0, y: 55 }); // insert 2
    ctrl.end();
    expect(ids(data())).toEqual(['b', 'c', 'a', 'd', 'e']);
    expect(anchors).toEqual([{ after: 'c' }]);
  });

  it('a move to the front anchors before the new second; a lone item is empty', () => {
    const data = signal(rows('a', 'b', 'c'));
    const anchors: Anchor[] = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ anchor }) => anchors.push(anchor),
    });
    ctrl.moveItem(2, 0);
    expect(anchors).toEqual([{ before: 'a' }]);
  });

  it('a cross-list drop: onItemArrived and onItemLeft both name the landing place in the target', () => {
    const a = signal(rows('a', 'b', 'c'));
    const b = signal(rows('k', 'l'));
    const left: Array<{ moved: Handle<string>; anchor: Anchor | null }> = [];
    const arrived: Array<{ moved: Handle<string>; anchor: Anchor }> = [];
    const group = sortableGroup<Row>();
    const ctrlA = reorderable(a, {
      key: (r) => r.id,
      group,
      onItemLeft: ({ moved, anchor }) => left.push({ moved, anchor }),
    });
    const ctrlB = reorderable(b, {
      key: (r) => r.id,
      group,
      onItemArrived: ({ moved, anchor }) => arrived.push({ moved, anchor }),
    });
    const gi = getGroupInternals(group);
    ctrlA.begin(
      'b',
      { source: 1, centers: [10, 30, 50], footprint: 20, axis: 'y' },
      30,
    );
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 1,
      insertIndex: 1,
      footprint: 20,
    });
    ctrlA.end();

    expect(ids(b())).toEqual(['k', 'b', 'l']);
    expect(arrived).toEqual([{ moved: 'b', anchor: { after: 'k' } }]);
    expect(left).toEqual([{ moved: 'b', anchor: { after: 'k' } }]);
  });

  it('an arrival into an empty list anchors empty', () => {
    const b = signal<Row[]>([]);
    const arrived: Anchor[] = [];
    const ctrl = reorderable(b, {
      key: (r) => r.id,
      onItemArrived: ({ anchor }) => arrived.push(anchor),
    });
    ctrl.insertAt({ id: 'z' }, 0);
    expect(arrived).toEqual([{ empty: true }]);
  });
});

/**
 * Native engine drop (astra review): the dragged item is the source's LIVE item for
 * the key, never the drag-start payload; the destination slot is the hover's neighbour
 * anchor resolved against the target's live keys.
 */
describe('native drop commit — live source item, anchored slot', () => {
  type Row = { id: string; v?: number };
  const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
  function lists() {
    const group = sortableGroup<Row>();
    const a = signal<Row[]>([{ id: 'a' }, { id: 'b', v: 1 }, { id: 'c' }]);
    const b = signal<Row[]>([{ id: 'k' }, { id: 'l' }]);
    const src = reorderable(a, { key: (r) => r.id, group });
    const dst = reorderable(b, { key: (r) => r.id, group });
    return { a, b, src, dst, payload: a()[1] };
  }

  it('the source deleted the dragged item mid-drag ⇒ nothing transfers, nothing is inserted, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { a, b, src, dst, payload } = lists();
      a.update((arr) => arr.filter((r) => r.id !== 'b'));
      const [beforeA, beforeB] = [a(), b()];
      commitNativeDrop(dst, src, payload, 1, slotAnchor(['k', 'l'], 1));
      expect(a()).toBe(beforeA);
      expect(b()).toBe(beforeB);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('the source replaced b with b′ mid-drag ⇒ b′ transfers and the source loses exactly b′', () => {
    const { a, b, src, dst, payload } = lists();
    const fresh = { id: 'b', v: 2 };
    a.update((arr) => arr.map((r) => (r.id === 'b' ? fresh : r)));
    commitNativeDrop(dst, src, payload, 1, slotAnchor(['k', 'l'], 1));
    expect(b()[1]).toBe(fresh);
    expect(ids(b())).toEqual(['k', 'b', 'l']);
    expect(ids(a())).toEqual(['a', 'c']);
  });

  it('the target changed after the hover: the drop lands at the hovered neighbour, not the old slot', () => {
    const { b, src, dst, payload } = lists();
    const anchor = slotAnchor(['k', 'l'], 1); // hovered between k and l
    b.update((arr) => [{ id: 'x' }, ...arr]); // a peer prepends to the target
    commitNativeDrop(dst, src, payload, 1, anchor);
    expect(ids(b())).toEqual(['x', 'k', 'b', 'l']);
  });

  it('the hovered neighbour is gone ⇒ no-op, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { a, b, src, dst, payload } = lists();
      const anchor = slotAnchor(['k', 'l'], 1); // { after: 'k' }
      b.update((arr) => arr.filter((r) => r.id !== 'k'));
      const [beforeA, beforeB] = [a(), b()];
      commitNativeDrop(dst, src, payload, 1, anchor);
      expect(a()).toBe(beforeA);
      expect(b()).toBe(beforeB);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('same-list: the anchored slot is resolved live, then turned into the final index', () => {
    const { a, src, payload } = lists();
    const anchor = slotAnchor(['a', 'b', 'c'], 3); // after c
    a.update((arr) => [{ id: 'z' }, ...arr]); // a peer prepends
    commitNativeDrop(src, src, payload, 3, anchor);
    expect(ids(a())).toEqual(['z', 'a', 'c', 'b']);
  });
});

/** Astra review: a cross-list drop lands at the HOVERED neighbour, resolved at release. */
describe('pointer cross-list drop — the hovered slot is an anchor, resolved at release', () => {
  type Row = { id: string };
  const ids = (arr: readonly Row[]) => arr.map((r) => r.id);
  const box = (top: number, height: number, left = 0, width = 100) =>
    ({
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  function target(
    b: ReturnType<typeof signal<Row[]>>,
    ctrl: ReturnType<typeof reorderable<Row, string>>,
  ) {
    // rendered target: 20px rows from y 0, container 0..100 × 0..200
    for (const r of b()) {
      const el = document.createElement('div');
      const id = r.id;
      el.getBoundingClientRect = () =>
        box(b().findIndex((x) => x.id === id) * 20, 20);
      ctrl.register(id, el);
    }
    const container = document.createElement('div');
    container.getBoundingClientRect = () => box(0, 200);
    ctrl.setContainer(container);
    ctrl.refreshBounds();
  }

  it('hover between a and b in [a, b]; the target becomes [x, a, b]; release ⇒ [x, a, m, b]', () => {
    const group = sortableGroup<Row>();
    const a = signal<Row[]>([{ id: 'm' }]);
    const b = signal<Row[]>([{ id: 'a' }, { id: 'b' }]);
    const ctrlA = reorderable(a, { key: (r) => r.id, group });
    const ctrlB = reorderable(b, { key: (r) => r.id, group });
    target(b, ctrlB);

    ctrlA.begin(
      'm',
      { source: 0, centers: [500], footprint: 20, axis: 'y' },
      500,
    );
    ctrlA.move({ x: 50, y: 20 }); // over B, between a (10) and b (30)
    expect(getGroupInternals(group).activeInsertIndex()).toBe(1);
    b.update((arr) => [{ id: 'x' }, ...arr]); // a peer prepends to the target
    ctrlA.end(); // no pointer move since

    expect(ids(b())).toEqual(['x', 'a', 'm', 'b']);
    expect(ids(a())).toEqual([]);
  });

  it('the hovered neighbour was removed ⇒ no transfer, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const group = sortableGroup<Row>();
      const a = signal<Row[]>([{ id: 'm' }]);
      const b = signal<Row[]>([{ id: 'a' }, { id: 'b' }]);
      const ctrlA = reorderable(a, { key: (r) => r.id, group });
      const ctrlB = reorderable(b, { key: (r) => r.id, group });
      target(b, ctrlB);
      ctrlA.begin(
        'm',
        { source: 0, centers: [500], footprint: 20, axis: 'y' },
        500,
      );
      ctrlA.move({ x: 50, y: 20 }); // { after: 'a' }
      b.update((arr) => arr.filter((r) => r.id !== 'a'));
      ctrlA.end();

      expect(ids(b())).toEqual(['b']);
      expect(ids(a())).toEqual(['m']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * [PIN M9] Duplicate keys: identity is the OCCURRENCE (a handle), a row binds to its
 * occurrence by item reference. Unique keys see their raw keys everywhere (the specs
 * above run unchanged).
 */
describe('reorderable controller — duplicate keys are occurrences [PIN M9]', () => {
  type Row = { id: string; n?: number };
  const ROW = 20;
  const rect = (i: number) =>
    ({
      top: i * ROW,
      bottom: i * ROW + ROW,
      left: 0,
      right: 100,
      width: 100,
      height: ROW,
      x: 0,
      y: i * ROW,
      toJSON: () => ({}),
    }) as DOMRect;

  /** One element per ROW (occurrence), measured at its live position, registered with its item. */
  function rendered(
    ctrl: ReturnType<typeof reorderable<Row, string>>,
    data: () => Row[],
  ) {
    const els = data().map((r) => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => rect(els.indexOf(el));
      ctrl.register(r.id, el, r);
      return el;
    });
    return els;
  }

  it('two distinct rows with one key: dragging the FIRST moves the first, and only it is the source', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const data = signal<Row[]>([a1, { id: 'b' }, a2]);
    const froms: number[] = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ from }) => froms.push(from),
    });
    const els = rendered(ctrl, data);
    const h1 = ctrl.keyForElement(els[0]);
    const h2 = ctrl.keyForElement(els[2]);
    expect(h1).not.toBe(h2); // one occurrence each

    const s1 = ctrl.itemState(() => a1);
    const s2 = ctrl.itemState(() => a2);
    ctrl.beginGesture(h1 as never, { x: 0, y: 10 });
    expect(s1.isSource()).toBe(true);
    expect(s2.isSource()).toBe(false); // one source, not every row sharing the key
    expect(s2.index()).toBe(2);
    ctrl.move({ x: 0, y: 55 }); // past b and a2 → last
    ctrl.end();

    expect(data()).toEqual([{ id: 'b' }, a2, a1]);
    expect(data()[1]).toBe(a2); // the other occurrence untouched
    expect(froms).toEqual([0]);
  });

  it('dragging the SECOND row moves the second; the first is not displaced as a source', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const data = signal<Row[]>([a1, { id: 'b' }, a2]);
    const ctrl = reorderable(data, { key: (r) => r.id });
    const els = rendered(ctrl, data);
    const s1 = ctrl.itemState(() => a1);
    ctrl.beginGesture(ctrl.keyForElement(els[2]) as never, { x: 0, y: 50 });
    expect(s1.isSource()).toBe(false);
    ctrl.move({ x: 0, y: 5 }); // to the top
    ctrl.end();
    expect(data()).toEqual([a2, a1, { id: 'b' }]);
  });

  it('takeOut removes exactly one occurrence', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const data = signal<Row[]>([a1, { id: 'b' }, a2]);
    const ctrl = reorderable(data, { key: (r) => r.id });
    ctrl.takeOut(a2, 0);
    expect(data()).toEqual([a1, { id: 'b' }]);
    expect(data()[0]).toBe(a1);
  });

  it('a cross-list transfer carries exactly the dragged occurrence; the source keeps the other', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const a = signal<Row[]>([a1, a2]);
    const b = signal<Row[]>([{ id: 'k' }]);
    const group = sortableGroup<Row>();
    const ctrlA = reorderable(a, { key: (r) => r.id, group });
    const ctrlB = reorderable(b, { key: (r) => r.id, group });
    const els = rendered(ctrlA, a);
    const gi = getGroupInternals(group);
    ctrlA.begin(
      ctrlA.keyForElement(els[0]) as never,
      { source: 0, centers: [10, 30], footprint: 20, axis: 'y' },
      10,
    );
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 0,
      insertIndex: 1,
      footprint: 20,
    });
    ctrlA.end();

    expect(b()[1]).toBe(a1);
    expect(a()).toEqual([a2]);
    expect(a()[0]).toBe(a2);
  });

  it('the same object twice [x, y, x]: dragging the second row moves the second occurrence', () => {
    const x = { id: 'x' };
    const y = { id: 'y' };
    const data = signal<Row[]>([x, y, x]);
    const froms: number[] = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ from }) => froms.push(from),
    });
    const els = rendered(ctrl, data); // registration order = row order
    ctrl.beginGesture(ctrl.keyForElement(els[2]) as never, { x: 0, y: 50 });
    ctrl.move({ x: 0, y: 5 });
    ctrl.end();
    expect(froms).toEqual([2]);
    expect(data()).toEqual([x, x, y]);
  });

  it('the same object twice [x, y, x]: dragging the FIRST row moves the first occurrence', () => {
    const x = { id: 'x' };
    const y = { id: 'y' };
    const data = signal<Row[]>([x, y, x]);
    const froms: number[] = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: ({ from }) => froms.push(from),
    });
    const els = rendered(ctrl, data);
    ctrl.beginGesture(ctrl.keyForElement(els[0]) as never, { x: 0, y: 10 });
    ctrl.move({ x: 0, y: 35 }); // past y only
    ctrl.end();
    expect(froms).toEqual([0]);
    expect(data()).toEqual([y, x, x]);
  });

  it('the same object twice: a transfer leaves exactly one x behind', () => {
    const x = { id: 'x' };
    const a = signal<Row[]>([x, x]);
    const b = signal<Row[]>([]);
    const group = sortableGroup<Row>();
    const ctrlA = reorderable(a, { key: (r) => r.id, group });
    const ctrlB = reorderable(b, { key: (r) => r.id, group });
    const els = rendered(ctrlA, a);
    const gi = getGroupInternals(group);
    ctrlA.begin(
      ctrlA.keyForElement(els[1]) as never,
      { source: 1, centers: [10, 30], footprint: 20, axis: 'y' },
      30,
    );
    gi.setActive({
      source: ctrlA,
      target: ctrlB,
      sourceIndex: 1,
      insertIndex: 0,
      footprint: 20,
    });
    ctrlA.end();
    expect(a()).toEqual([x]);
    expect(b()).toEqual([x]);
  });

  it('events name occurrences by handle; a key that never had duplicates stays its raw key', () => {
    const a1 = { id: 'a', n: 1 };
    const a2 = { id: 'a', n: 2 };
    const data = signal<Row[]>([a1, { id: 'b' }, a2]);
    const events: Array<{ moved: unknown; anchor: unknown }> = [];
    const ctrl = reorderable(data, {
      key: (r) => r.id,
      onReorder: (e) => events.push(e),
    });
    ctrl.moveItem(1, 0); // b to the front: b is unique, its neighbour is an occurrence of a
    expect(events[0].moved).toBe('b');
    const before = (events[0].anchor as { before: unknown }).before;
    expect(isKeyHandle(before)).toBe(true);
    expect((before as { key: string }).key).toBe('a');
  });
});
