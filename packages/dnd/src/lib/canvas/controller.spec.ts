import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { opLog, store, storeHistory, type OpBatch } from '@mmstack/primitives';

import {
  canvas,
  type CanvasCommitEvent,
  type CanvasOptions,
  type CanvasReparentEvent,
} from './controller';
import type { CanvasFrame } from './geometry';

type Widget = {
  id: string;
  kind?: 'widget' | 'stage';
  parent?: string | null;
  frame: CanvasFrame;
};

const f = (x: number, y: number, width = 40, height = 40): CanvasFrame => ({
  x,
  y,
  width,
  height,
});

const OPTS: CanvasOptions<Widget, string> = {
  key: (w) => w.id,
  frame: (w) => w.frame,
  patch: (w, frame) => ({ ...w, frame }),
};

/** A fake element whose rect mirrors a live frame lookup (surface at 0,0). */
function fakeEl(get: () => CanvasFrame): HTMLElement {
  return {
    getBoundingClientRect: () => {
      const fr = get();
      return {
        left: fr.x,
        top: fr.y,
        width: fr.width,
        height: fr.height,
        right: fr.x + fr.width,
        bottom: fr.y + fr.height,
      };
    },
  } as unknown as HTMLElement;
}

const SURFACE = {
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
} as unknown as HTMLElement;

function setup(
  extra: Partial<CanvasOptions<Widget, string>> = {},
  items: Widget[] = [
    { id: 'a', frame: f(100, 100) },
    { id: 'b', frame: f(200, 100) },
    { id: 'c', frame: f(300, 300, 60, 60) },
  ],
) {
  const source = signal<readonly Widget[]>(items);
  const ctrl = canvas<Widget, string>(source, { ...OPTS, ...extra });
  ctrl.setSurface(SURFACE);
  const els = new Map<string, HTMLElement>();
  for (const it of items) {
    const el = fakeEl(
      () => source().find((i) => i.id === it.id)?.frame ?? it.frame,
    );
    els.set(it.id, el);
    ctrl.register(it.id, el);
  }
  const beginMove = (id: string, at?: { x: number; y: number }) => {
    const fr = source().find((i) => i.id === id)?.frame;
    const start = at ?? { x: (fr?.x ?? 0) + 5, y: (fr?.y ?? 0) + 5 };
    return ctrl.beginFromPress(
      { mode: 'move', itemEl: els.get(id) as HTMLElement },
      start,
      false,
    );
  };
  return { source, ctrl, els, beginMove };
}

describe('canvas controller', () => {
  describe('move', () => {
    it('commits the delta exactly once on end; source untouched mid-drag', () => {
      const commits: CanvasCommitEvent<Widget, string>[] = [];
      const { source, ctrl, beginMove } = setup({
        onCommit: (e) => commits.push(e),
      });
      const before = source();
      let writes = 0;
      const origUpdate = source.update.bind(source);
      vi.spyOn(source, 'update').mockImplementation((fn) => {
        writes++;
        origUpdate(fn);
      });

      expect(beginMove('a')).toBe(true);
      ctrl.move({ x: 130, y: 125 });
      ctrl.move({ x: 145, y: 135 });
      expect(source()).toBe(before);

      ctrl.end();
      expect(writes).toBe(1);
      expect(source().find((i) => i.id === 'a')?.frame).toMatchObject({
        x: 140,
        y: 130,
      });
      expect(commits).toHaveLength(1);
      expect(commits[0].mode).toBe('move');
      expect(commits[0].patches.get('a')).toMatchObject({ x: 140, y: 130 });
      expect(ctrl.session.active()).toBe(false);
    });

    it('untouched items keep reference identity through the commit', () => {
      const { source, ctrl, beginMove } = setup();
      const b0 = source().find((i) => i.id === 'b');
      const c0 = source().find((i) => i.id === 'c');
      beginMove('a');
      ctrl.move({ x: 150, y: 150 });
      ctrl.end();
      expect(source().find((i) => i.id === 'b')).toBe(b0);
      expect(source().find((i) => i.id === 'c')).toBe(c0);
    });

    it('shift-drag of an unselected item ADDS it to the selection', () => {
      const { ctrl, els } = setup();
      ctrl.selection.set(['a', 'b']);
      expect(
        ctrl.beginFromPress(
          { mode: 'move', itemEl: els.get('c') as HTMLElement },
          { x: 310, y: 310 },
          true, // shift held at press
        ),
      ).toBe(true);
      expect(ctrl.selection.ids()).toEqual(['a', 'b', 'c']);
      ctrl.cancel();
    });

    it('drag of an unselected item selects it; the whole selection moves', () => {
      const { source, ctrl, beginMove } = setup();
      ctrl.selection.set(['a', 'b']);
      beginMove('a');
      expect(ctrl.selection.ids()).toEqual(['a', 'b']);
      ctrl.move({ x: 125, y: 105 });
      ctrl.end();
      expect(source().find((i) => i.id === 'a')?.frame).toMatchObject({
        x: 120,
      });
      expect(source().find((i) => i.id === 'b')?.frame).toMatchObject({
        x: 220,
      });
      expect(source().find((i) => i.id === 'c')?.frame).toMatchObject({
        x: 300,
      });

      beginMove('c'); // unselected → becomes THE selection
      expect(ctrl.selection.ids()).toEqual(['c']);
      ctrl.cancel();
    });

    it('a no-move drop commits nothing', () => {
      const { source, ctrl, beginMove } = setup();
      const before = source();
      beginMove('a');
      ctrl.end();
      expect(source()).toBe(before);
    });

    it('cancel never writes', () => {
      const { source, ctrl, beginMove } = setup();
      const before = source();
      beginMove('a');
      ctrl.move({ x: 500, y: 500 });
      ctrl.cancel();
      expect(source()).toBe(before);
      expect(ctrl.session.active()).toBe(false);
    });

    it('lockedKeys reject the press; canTransform gates per mode', () => {
      const locked = signal<ReadonlySet<string>>(new Set(['a']));
      const { beginMove } = setup({
        lockedKeys: locked,
        canTransform: (item, mode) => !(item.id === 'b' && mode === 'move'),
      });
      expect(beginMove('a')).toBe(false);
      expect(beginMove('b')).toBe(false);
      expect(beginMove('c')).toBe(true);
    });
  });

  describe('marquee + selection', () => {
    it('live-selects intersecting items and commits nothing', () => {
      const { source, ctrl } = setup();
      const before = source();
      expect(
        ctrl.beginFromPress({ mode: 'marquee' }, { x: 50, y: 50 }, false),
      ).toBe(true);
      ctrl.move({ x: 260, y: 160 }); // covers a and b, not c
      expect(ctrl.selection.ids()).toEqual(['a', 'b']);
      ctrl.move({ x: 120, y: 120 }); // shrinks to a only
      expect(ctrl.selection.ids()).toEqual(['a']);
      ctrl.end();
      expect(source()).toBe(before);
      expect(ctrl.selection.ids()).toEqual(['a']);
    });

    it('press selects (Shift toggles) and clearPress empties', () => {
      const { ctrl } = setup();
      ctrl.press('a', false);
      expect(ctrl.selection.ids()).toEqual(['a']);
      ctrl.press('b', true);
      expect(ctrl.selection.ids()).toEqual(['a', 'b']);
      ctrl.press('a', true);
      expect(ctrl.selection.ids()).toEqual(['b']);
      ctrl.clearPress();
      expect(ctrl.selection.ids()).toEqual([]);
    });
  });

  describe('resize + rotate (single selection)', () => {
    it('resize commits the box delta onto the lens frame', () => {
      const { source, ctrl } = setup();
      ctrl.selection.set(['a']);
      expect(
        ctrl.beginFromPress(
          { mode: 'resize', direction: 'se' },
          { x: 140, y: 140 },
          false,
        ),
      ).toBe(true);
      ctrl.move({ x: 160, y: 150 });
      ctrl.end();
      expect(source().find((i) => i.id === 'a')?.frame).toMatchObject({
        x: 100,
        y: 100,
        width: 60,
        height: 50,
      });
    });

    it('resize requires exactly one selected item', () => {
      const { ctrl } = setup();
      ctrl.selection.set(['a', 'b']);
      expect(
        ctrl.beginFromPress(
          { mode: 'resize', direction: 'se' },
          { x: 140, y: 140 },
          false,
        ),
      ).toBe(false);
    });

    it('nudgeResize respects resize.max', () => {
      const { source, ctrl } = setup({
        grid: { size: 8 },
        resize: { max: { width: 44, height: 44 } },
      });
      ctrl.selection.set(['a']); // a is 40×40
      expect(ctrl.nudgeResize(1, 1, false)).toBe(true);
      expect(source().find((i) => i.id === 'a')?.frame).toMatchObject({
        width: 44,
        height: 44,
      });
      expect(ctrl.nudgeResize(1, 0, false)).toBe(false); // already at max
    });

    it('a zero-sweep rotate release on a non-normalized rotation commits nothing', () => {
      const items: Widget[] = [
        { id: 'a', frame: { ...f(100, 100), rotation: -90 } },
      ];
      const commits: CanvasCommitEvent<Widget, string>[] = [];
      const { source, ctrl } = setup(
        { rotate: true, onCommit: (e) => commits.push(e) },
        items,
      );
      const before = source();
      ctrl.selection.set(['a']);
      ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false);
      ctrl.move({ x: 152, y: 121 }); // wiggle past threshold...
      ctrl.move({ x: 150, y: 120 }); // ...and back to the exact start
      ctrl.end();
      expect(commits).toHaveLength(0);
      expect(source()).toBe(before); // identity intact, no spurious op
    });

    it('rotate commits an absolute angle', () => {
      const { source, ctrl } = setup({ rotate: { snap: 15 } });
      ctrl.selection.set(['a']);
      // pivot = (120,120); start east of it
      expect(
        ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false),
      ).toBe(true);
      ctrl.move({ x: 120, y: 150 }); // sweep 90°
      ctrl.end();
      expect(source().find((i) => i.id === 'a')?.frame.rotation).toBe(90);
    });
  });

  describe('containment', () => {
    const stageItems: Widget[] = [
      { id: 'stage1', kind: 'stage', parent: null, frame: f(0, 0, 200, 200) },
      { id: 'stage2', kind: 'stage', parent: null, frame: f(300, 0, 200, 200) },
      { id: 'a', kind: 'widget', parent: 'stage1', frame: f(50, 50) },
    ];

    it('reports the hover container and hands a rebased reparent to the consumer', () => {
      const reparents: CanvasReparentEvent<Widget, string>[] = [];
      const commits: CanvasCommitEvent<Widget, string>[] = [];
      const { source, ctrl, beginMove } = setup(
        {
          containers: {
            isContainer: (w) => w.kind === 'stage',
            containerOf: (w) => w.parent ?? null,
            canContain: (container, item) => container.id !== item.id,
          },
          onReparent: (e) => reparents.push(e),
          onCommit: (e) => commits.push(e),
        },
        stageItems,
      );
      const before = source();

      beginMove('a', { x: 60, y: 60 });
      ctrl.move({ x: 360, y: 60 }); // over stage2
      expect(ctrl.session.hoverContainer()).toBe('stage2');
      ctrl.end();

      expect(commits).toHaveLength(0);
      expect(source()).toBe(before); // reparents are consumer-applied
      expect(reparents).toHaveLength(1);
      expect(reparents[0].container).toBe('stage2');
      // delta +300 x, rebased by stage1(0,0) → stage2(300,0): 50+300+(0-300)=50
      expect(reparents[0].patches.get('a')).toMatchObject({ x: 50, y: 50 });
    });

    it('a zero-delta drop over a NEW container still reparents (grid snap rounding)', () => {
      const reparents: CanvasReparentEvent<Widget, string>[] = [];
      const { ctrl, beginMove } = setup(
        {
          grid: { size: 1000 }, // coarse grid: the origin snaps back to (0,0)
          snap: false,
          containers: {
            isContainer: (w) => w.kind === 'stage',
            containerOf: (w) => w.parent ?? null,
          },
          onReparent: (e) => reparents.push(e),
        },
        [
          ...stageItems.filter((w) => w.kind === 'stage'),
          // grid-aligned origin so the snapped delta is exactly zero
          { id: 'a', kind: 'widget', parent: 'stage1', frame: f(0, 0) },
        ],
      );
      beginMove('a', { x: 20, y: 20 });
      ctrl.move({ x: 330, y: 20 }); // pointer crossed into stage2...
      expect(ctrl.session.hoverContainer()).toBe('stage2');
      expect(ctrl.session.overlayDeltaX()).toBe(0); // ...but the origin snapped back
      ctrl.end();
      expect(reparents).toHaveLength(1);
      expect(reparents[0].container).toBe('stage2');
    });

    it('a move within the same container auto-commits with the container reported', () => {
      const commits: CanvasCommitEvent<Widget, string>[] = [];
      const { source, ctrl, beginMove } = setup(
        {
          containers: {
            isContainer: (w) => w.kind === 'stage',
            containerOf: (w) => w.parent ?? null,
          },
          onCommit: (e) => commits.push(e),
        },
        stageItems,
      );
      beginMove('a', { x: 60, y: 60 });
      ctrl.move({ x: 80, y: 60 }); // still inside stage1
      expect(ctrl.session.hoverContainer()).toBe('stage1');
      ctrl.end();
      expect(commits).toHaveLength(1);
      expect(commits[0].container).toBe('stage1');
      expect(source().find((i) => i.id === 'a')?.frame).toMatchObject({
        x: 70,
        y: 50,
      });
    });
  });

  describe('remote overlays', () => {
    it('a remote frame wins over the source frame in itemState', () => {
      const remote = signal<ReadonlyMap<string, CanvasFrame>>(new Map());
      const { source, ctrl } = setup({ remoteOverlays: remote });
      const state = ctrl.itemState(
        () => source().find((i) => i.id === 'b') as Widget,
      );
      expect(state.leftPx()).toBe(200);
      remote.set(new Map([['b', f(555, 60)]]));
      expect(state.leftPx()).toBe(555);
      expect(state.topPx()).toBe(60);
      remote.set(new Map());
      expect(state.leftPx()).toBe(200);
    });
  });

  describe('keyboard', () => {
    it('nudges the selection by the grid step (large = ×10) and commits once', () => {
      const commits: CanvasCommitEvent<Widget, string>[] = [];
      const { source, ctrl } = setup({
        grid: { size: 8 },
        onCommit: (e) => commits.push(e),
      });
      ctrl.selection.set(['a', 'b']);
      expect(ctrl.nudge(1, 0, false)).toBe(true);
      expect(source().find((i) => i.id === 'a')?.frame.x).toBe(108);
      expect(source().find((i) => i.id === 'b')?.frame.x).toBe(208);
      expect(ctrl.nudge(0, 1, true)).toBe(true);
      expect(source().find((i) => i.id === 'a')?.frame.y).toBe(180);
      expect(commits).toHaveLength(2);
      expect(commits[1].mode).toBe('keyboard');
    });

    it('nudgeResize resizes the single selected item', () => {
      const { source, ctrl } = setup({ grid: { size: 8 } });
      ctrl.selection.set(['c']);
      expect(ctrl.nudgeResize(1, 1, false)).toBe(true);
      expect(source().find((i) => i.id === 'c')?.frame).toMatchObject({
        width: 68,
        height: 68,
      });
      ctrl.selection.set(['a', 'b']);
      expect(ctrl.nudgeResize(1, 0, false)).toBe(false);
    });
  });
});

describe('canvas — store seam (op-log / undo)', () => {
  type Doc = { widgets: Widget[] };

  function setupStore() {
    return TestBed.runInInjectionContext(() => {
      const s = store<Doc>({
        widgets: [
          { id: 'a', frame: f(100, 100) },
          { id: 'b', frame: f(200, 100) },
        ],
      });
      const batches: OpBatch[] = [];
      opLog(s, { origin: 'me' }).subscribe((b) => batches.push(b));
      const history = storeHistory(s);

      const ctrl = canvas<Widget, string>(s.widgets, OPTS);
      ctrl.setSurface(SURFACE);
      const els = new Map<string, HTMLElement>();
      for (const it of s.widgets()) {
        const el = fakeEl(
          () => s.widgets().find((i) => i.id === it.id)?.frame ?? it.frame,
        );
        els.set(it.id, el);
        ctrl.register(it.id, el);
      }
      return { s, ctrl, batches, history, els };
    });
  }

  it('one gesture = ONE batch of exact per-property ops', () => {
    const { ctrl, batches, els } = setupStore();
    ctrl.beginFromPress(
      { mode: 'move', itemEl: els.get('a') as HTMLElement },
      { x: 105, y: 105 },
      false,
    );
    ctrl.move({ x: 135, y: 125 });
    ctrl.move({ x: 145, y: 145 });
    TestBed.tick();
    expect(batches).toHaveLength(0); // nothing mid-drag

    ctrl.end();
    TestBed.tick();
    expect(batches).toHaveLength(1);
    expect(batches[0].ops).toEqual([
      { kind: 'set', path: ['widgets', 0, 'frame', 'x'], prev: 100, next: 140 },
      { kind: 'set', path: ['widgets', 0, 'frame', 'y'], prev: 100, next: 140 },
    ]);
  });

  it('storeHistory sees one undo entry per gesture; undo restores the frame', () => {
    const { s, ctrl, history, els } = setupStore();
    const el = els.get('a') as HTMLElement;

    ctrl.beginFromPress({ mode: 'move', itemEl: el }, { x: 105, y: 105 }, false);
    ctrl.move({ x: 145, y: 125 });
    ctrl.end();
    TestBed.tick();
    expect(s.widgets()[0].frame).toMatchObject({ x: 140, y: 120 });
    expect(history.canUndo()).toBe(true);

    history.undo();
    TestBed.tick();
    expect(s.widgets()[0].frame).toMatchObject({ x: 100, y: 100 });
    expect(history.canUndo()).toBe(false);

    history.redo();
    TestBed.tick();
    expect(s.widgets()[0].frame).toMatchObject({ x: 140, y: 120 });
  });
});
