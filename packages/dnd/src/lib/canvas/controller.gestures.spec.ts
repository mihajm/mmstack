import { signal, type WritableSignal } from '@angular/core';

import {
  canvas,
  type CanvasCommitEvent,
  type CanvasOptions,
  type CanvasReparentEvent,
} from './controller';
import type { CanvasFrame } from './geometry';
import type { CanvasSpaceTransform } from './session';

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

const ITEMS: Widget[] = [
  { id: 'a', frame: f(100, 100) },
  { id: 'b', frame: f(200, 100) },
  { id: 'c', frame: f(300, 300, 60, 60) },
];

type View = {
  surface?: { x: number; y: number };
  space?: WritableSignal<CanvasSpaceTransform>;
};

/** Fake elements project each live frame through the surface origin and the pan/zoom space. */
function setup(
  extra: Partial<CanvasOptions<Widget, string>> = {},
  items: Widget[] = ITEMS,
  view: View = {},
) {
  const origin = view.surface ?? { x: 0, y: 0 };
  const space = view.space;
  const source = signal<readonly Widget[]>(items);
  const ctrl = canvas<Widget, string>(source, {
    ...OPTS,
    ...(space ? { space: { transform: space } } : {}),
    ...extra,
  });
  ctrl.setSurface({
    getBoundingClientRect: () => ({ left: origin.x, top: origin.y }),
  } as unknown as HTMLElement);
  const toViewport = (fr: CanvasFrame) => {
    const t = space?.() ?? { x: 0, y: 0, scale: 1 };
    return {
      left: origin.x + t.x + fr.x * t.scale,
      top: origin.y + t.y + fr.y * t.scale,
      width: fr.width * t.scale,
      height: fr.height * t.scale,
    };
  };
  const els = new Map<string, HTMLElement>();
  for (const it of items) {
    const el = {
      getBoundingClientRect: () =>
        toViewport(source().find((i) => i.id === it.id)?.frame ?? it.frame),
    } as unknown as HTMLElement;
    els.set(it.id, el);
    ctrl.register(it.id, el);
  }
  const frameOf = (id: string) => source().find((i) => i.id === id)?.frame;
  const beginMove = (id: string, at: { x: number; y: number }, shift = false) =>
    ctrl.beginFromPress(
      { mode: 'move', itemEl: els.get(id) as HTMLElement },
      at,
      shift,
    );
  const beginResize = (
    direction: 'se' | 'nw' | 'e' | 's',
    at: { x: number; y: number },
  ) => ctrl.beginFromPress({ mode: 'resize', direction }, at, false);
  const beginRotate = (at: { x: number; y: number }) =>
    ctrl.beginFromPress({ mode: 'rotate' }, at, false);
  const drop = (id: string) =>
    source.update((arr) => arr.filter((i) => i.id !== id));
  return {
    source,
    ctrl,
    els,
    frameOf,
    beginMove,
    beginResize,
    beginRotate,
    drop,
  };
}

const commitsOf = () => {
  const commits: CanvasCommitEvent<Widget, string>[] = [];
  return {
    commits,
    onCommit: (e: CanvasCommitEvent<Widget, string>) => commits.push(e),
  };
};

describe('canvas controller: a refused group move leaves the selection alone', () => {
  it('shift-press with an unrendered selected item is refused and selects nothing new', () => {
    const { ctrl, els, beginMove } = setup();
    ctrl.selection.set(['b']);
    ctrl.unregister('b', els.get('b') as HTMLElement);
    expect(beginMove('a', { x: 105, y: 105 }, true)).toBe(false);
    expect(ctrl.selection.ids()).toEqual(['b']);
    expect(ctrl.session.active()).toBe(false);
  });

  it('a plain press on an item still replaces the selection and drags', () => {
    const { ctrl, els, beginMove } = setup();
    ctrl.selection.set(['b']);
    ctrl.unregister('b', els.get('b') as HTMLElement);
    expect(beginMove('a', { x: 105, y: 105 })).toBe(true);
    expect(ctrl.selection.ids()).toEqual(['a']);
  });
});

describe('canvas controller: items deleted mid-gesture', () => {
  it('a move commits only the items still in the source', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, frameOf, beginMove, drop, source } = setup({ onCommit });
    ctrl.selection.set(['a', 'b']);
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 125, y: 105 });
    drop('b');
    expect([...(ctrl.liveFrames()?.keys() ?? [])]).toEqual(['a']);
    expect(() => ctrl.end()).not.toThrow();
    expect([...commits[0].patches.keys()]).toEqual(['a']);
    expect(frameOf('a')).toMatchObject({ x: 120, y: 100 });
    expect(source().map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('a reparent names only the items still in the source', () => {
    const reparents: CanvasReparentEvent<Widget, string>[] = [];
    const { ctrl, beginMove, drop } = setup(
      {
        containers: {
          isContainer: (w) => w.kind === 'stage',
          containerOf: (w) => w.parent ?? null,
        },
        onReparent: (e) => reparents.push(e),
      },
      [
        { id: 's', kind: 'stage', parent: null, frame: f(400, 0, 200, 200) },
        { id: 'a', parent: null, frame: f(0, 0) },
        { id: 'b', parent: null, frame: f(100, 0) },
      ],
    );
    ctrl.selection.set(['a', 'b']);
    beginMove('a', { x: 5, y: 5 });
    ctrl.move({ x: 455, y: 5 });
    drop('b');
    expect(() => ctrl.end()).not.toThrow();
    expect([...reparents[0].patches.keys()]).toEqual(['a']);
  });

  it.each(['resize', 'rotate'] as const)(
    'a %s of a deleted item commits nothing and ends cleanly',
    (kind) => {
      const { commits, onCommit } = commitsOf();
      const s = setup({ rotate: true, onCommit });
      s.ctrl.selection.set(['a']);
      if (kind === 'resize') s.beginResize('se', { x: 140, y: 140 });
      else s.beginRotate({ x: 150, y: 120 });
      s.ctrl.move({ x: 120, y: 160 });
      s.drop('a');
      expect(s.ctrl.liveFrames()?.size).toBe(0);
      expect(() => s.ctrl.end()).not.toThrow();
      expect(commits).toHaveLength(0);
      expect(s.ctrl.session.active()).toBe(false);
    },
  );
});

describe('canvas controller: items with no rendered element', () => {
  it('a sibling with no element is neither a snap target nor a crash', () => {
    const { ctrl, els, frameOf, beginMove, beginResize } = setup();
    ctrl.unregister('c', els.get('c') as HTMLElement);
    expect(beginMove('a', { x: 105, y: 105 })).toBe(true);
    ctrl.move({ x: 125, y: 105 });
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 120, y: 100 });

    ctrl.selection.set(['a']);
    expect(beginResize('se', { x: 160, y: 140 })).toBe(true);
    ctrl.move({ x: 170, y: 150 });
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ width: 50, height: 50 });
  });

  it('a selected item with no element cannot be resized', () => {
    const { ctrl, els, beginResize } = setup();
    ctrl.selection.set(['a']);
    ctrl.unregister('a', els.get('a') as HTMLElement);
    expect(beginResize('se', { x: 140, y: 140 })).toBe(false);
    expect(ctrl.keyForElement(els.get('a') as HTMLElement)).toBeUndefined();
  });

  it('a selected key missing from the source cannot be resized', () => {
    const { ctrl, beginResize } = setup();
    ctrl.selection.set(['ghost']);
    expect(beginResize('se', { x: 140, y: 140 })).toBe(false);
  });
});

describe('canvas controller: element registration', () => {
  it('keyForElement resolves registered elements only', () => {
    const { ctrl, els } = setup();
    expect(ctrl.keyForElement(els.get('a') as HTMLElement)).toBe('a');
    expect(ctrl.keyForElement({} as HTMLElement)).toBeUndefined();
  });

  it('unregistering a replaced element keeps the live one', () => {
    const { ctrl, els, frameOf, beginResize } = setup();
    const el2 = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 100,
        width: 40,
        height: 40,
      }),
    } as unknown as HTMLElement;
    ctrl.register('a', el2);
    ctrl.unregister('a', els.get('a') as HTMLElement);
    expect(ctrl.keyForElement(el2)).toBe('a');
    ctrl.selection.set(['a']);
    expect(beginResize('se', { x: 140, y: 140 })).toBe(true);
    ctrl.move({ x: 150, y: 150 });
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ width: 50, height: 50 });
  });
});

describe('canvas controller: projection through the surface and the space', () => {
  it('a surface offset applies to the start point and the live pointer alike', () => {
    const { frameOf, beginMove, ctrl } = setup({}, ITEMS, {
      surface: { x: 50, y: 30 },
    });
    beginMove('a', { x: 155, y: 135 });
    ctrl.move({ x: 175, y: 145 });
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 120, y: 110 });
  });

  it('bounds clamp in canvas space under a surface offset', () => {
    const { frameOf, beginMove, ctrl } = setup(
      { bounds: { x: 0, y: 0, width: 300, height: 300 } },
      ITEMS,
      { surface: { x: 50, y: 30 } },
    );
    beginMove('a', { x: 155, y: 135 });
    ctrl.move({ x: 2155, y: 135 });
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 260, y: 100 });
  });

  describe('under pan and zoom (space x 10, y 20, scale 2; surface at 50, 30)', () => {
    const zoomed = (extra: Partial<CanvasOptions<Widget, string>> = {}) =>
      setup(extra, ITEMS, {
        surface: { x: 50, y: 30 },
        space: signal({ x: 10, y: 20, scale: 2 }),
      });
    // viewport point of canvas point p: surface + pan + p * scale
    const vp = (x: number, y: number) => ({ x: 60 + 2 * x, y: 50 + 2 * y });

    it('a 40px pointer move is a 20 canvas px move', () => {
      const { frameOf, beginMove, ctrl } = zoomed();
      beginMove('a', vp(105, 105));
      ctrl.move(vp(125, 125));
      ctrl.end();
      expect(frameOf('a')).toMatchObject({ x: 120, y: 120 });
    });

    it('measured boxes clamp to the bounds in canvas space', () => {
      const { frameOf, beginMove, ctrl } = zoomed({
        bounds: { x: 0, y: 0, width: 300, height: 300 },
      });
      beginMove('a', vp(105, 105));
      ctrl.move(vp(2000, 2000));
      ctrl.end();
      expect(frameOf('a')).toMatchObject({ x: 260, y: 260 });
    });

    it('a marquee over a canvas box selects exactly that item', () => {
      const { ctrl } = zoomed();
      ctrl.beginFromPress({ mode: 'marquee' }, vp(99, 99), false);
      ctrl.move(vp(141, 141));
      expect(ctrl.selection.ids()).toEqual(['a']);
      ctrl.end();
    });
  });

  it('the auto-scroll delta moves the drop with the scrolled surface', () => {
    const { frameOf, beginMove, ctrl } = setup();
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 105, y: 105 });
    ctrl.setScrollDelta(40, 30);
    ctrl.end();
    expect(frameOf('a')).toMatchObject({ x: 140, y: 130 });
  });
});

describe('canvas controller: gesture lifecycle', () => {
  it('move and end after a programmatic cancel are no-ops', () => {
    const { source, ctrl, beginMove } = setup();
    const before = source();
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 125, y: 105 });
    ctrl.cancel();
    expect(() => ctrl.move({ x: 150, y: 150 })).not.toThrow();
    expect(() => ctrl.end()).not.toThrow();
    expect(source()).toBe(before);
  });

  it('dispose mid-gesture resets it, so the next press starts', () => {
    const { source, ctrl, beginMove } = setup();
    const before = source();
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 125, y: 105 });
    ctrl.dispose();
    expect(ctrl.session.active()).toBe(false);
    expect(beginMove('a', { x: 105, y: 105 })).toBe(true);
    ctrl.cancel();
    expect(source()).toBe(before);
  });
});

describe('canvas controller: marquee', () => {
  const grid3: Widget[] = [
    { id: 'a', frame: f(0, 0) },
    { id: 'b', frame: f(100, 0) },
    { id: 'c', frame: f(0, 100) },
  ];

  it('marquee: false refuses the rubber band', () => {
    const { ctrl } = setup({ marquee: false });
    expect(ctrl.marquee).toBe(false);
    expect(
      ctrl.beginFromPress({ mode: 'marquee' }, { x: 0, y: 0 }, false),
    ).toBe(false);
    expect(ctrl.session.active()).toBe(false);
    ctrl.move({ x: 500, y: 500 });
    expect(ctrl.selection.ids()).toEqual([]);
  });

  it('a hit set that changes at equal length replaces the selection', () => {
    const { ctrl } = setup({}, grid3);
    ctrl.beginFromPress({ mode: 'marquee' }, { x: -10, y: -10 }, false);
    ctrl.move({ x: 110, y: 20 });
    expect(ctrl.selection.ids()).toEqual(['a', 'b']);
    ctrl.move({ x: 20, y: 110 });
    expect(ctrl.selection.ids()).toEqual(['a', 'c']);
    ctrl.end();

    ctrl.beginFromPress({ mode: 'marquee' }, { x: 50, y: 50 }, false);
    ctrl.move({ x: 10, y: 10 });
    expect(ctrl.selection.ids()).toEqual(['a']);
    ctrl.move({ x: 110, y: 10 });
    expect(ctrl.selection.ids()).toEqual(['b']);
    ctrl.end();
  });

  it('publishes no live frames and ends fully on release', () => {
    const { ctrl } = setup({}, grid3);
    ctrl.beginFromPress({ mode: 'marquee' }, { x: -10, y: -10 }, false);
    ctrl.move({ x: 50, y: 50 });
    expect(ctrl.liveFrames()).toBeNull();
    ctrl.end();
    expect(ctrl.session.active()).toBe(false);
    expect(ctrl.session.marqueeRect()).toBeNull();
    ctrl.move({ x: 200, y: 200 });
    expect(ctrl.selection.ids()).toEqual(['a']);
  });
});

describe('canvas controller: locks and gates on press', () => {
  it('a locked item press changes nothing, with or without Shift', () => {
    const { ctrl, beginMove } = setup({
      lockedKeys: signal(new Set(['a'])),
    });
    ctrl.selection.set(['b']);
    expect(beginMove('a', { x: 105, y: 105 })).toBe(false);
    expect(ctrl.selection.ids()).toEqual(['b']);
    expect(beginMove('a', { x: 105, y: 105 }, true)).toBe(false);
    expect(ctrl.selection.ids()).toEqual(['b']);
    expect(ctrl.session.active()).toBe(false);
  });

  it('a press refused by canTransform(move) changes nothing', () => {
    const gate = vi.fn(
      (item: Widget, mode: string) => item.id !== 'b' || mode !== 'move',
    );
    const { ctrl, beginMove } = setup({ canTransform: gate });
    ctrl.selection.set(['a']);
    expect(beginMove('b', { x: 205, y: 105 }, true)).toBe(false);
    expect(ctrl.selection.ids()).toEqual(['a']);
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b' }),
      'move',
    );
  });

  it('a selected rider blocked for move stays put while the rest moves', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, frameOf, beginMove } = setup({
      onCommit,
      canTransform: (item, mode) => !(item.id === 'b' && mode === 'move'),
    });
    ctrl.selection.set(['a', 'b']);
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 125, y: 105 });
    ctrl.end();
    expect([...commits[0].patches.keys()]).toEqual(['a']);
    expect(frameOf('b')).toMatchObject({ x: 200, y: 100 });
  });

  it('a locked single selection cannot be resized or rotated', () => {
    const { source, ctrl, beginResize, beginRotate } = setup({
      rotate: true,
      lockedKeys: signal(new Set(['a'])),
    });
    const before = source();
    ctrl.selection.set(['a']);
    expect(beginResize('se', { x: 140, y: 140 })).toBe(false);
    expect(beginRotate({ x: 150, y: 120 })).toBe(false);
    expect(ctrl.session.active()).toBe(false);
    expect(source()).toBe(before);
  });

  it('canTransform gates resize and rotate by their own mode', () => {
    const gate = vi.fn((_item: Widget, mode: string) => mode === 'move');
    const { ctrl, beginResize, beginRotate } = setup({
      rotate: true,
      canTransform: gate,
    });
    ctrl.selection.set(['a']);
    expect(beginResize('se', { x: 140, y: 140 })).toBe(false);
    expect(beginRotate({ x: 150, y: 120 })).toBe(false);
    expect(gate.mock.calls.map((c) => c[1])).toEqual(['resize', 'rotate']);
  });
});

describe('canvas controller: resize and rotate commits', () => {
  it.each([
    ['nw', { x: 100, y: 100 }, { x: 90, y: 80 }, f(90, 80, 50, 60)],
    ['e', { x: 140, y: 120 }, { x: 160, y: 120 }, f(100, 100, 60, 40)],
    ['s', { x: 120, y: 140 }, { x: 120, y: 160 }, f(100, 100, 40, 60)],
  ] as const)('a %s resize commits its frame once', (dir, from, to, frame) => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, source, frameOf, beginResize } = setup({ onCommit });
    ctrl.selection.set(['a']);
    beginResize(dir, from);
    ctrl.move(to);
    expect(ctrl.liveFrames()?.get('a')).toEqual(frame);
    ctrl.end();
    expect(frameOf('a')).toEqual(frame);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      patches: new Map([['a', frame]]),
      mode: 'resize',
      container: null,
      items: source(),
    });
  });

  it('a resize released where it started commits nothing', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, source, beginResize } = setup({ onCommit });
    const before = source();
    ctrl.selection.set(['a']);
    beginResize('se', { x: 140, y: 140 });
    ctrl.move({ x: 152, y: 141 });
    ctrl.move({ x: 140, y: 140 });
    ctrl.end();
    expect(commits).toHaveLength(0);
    expect(source()).toBe(before);
  });

  it.each([
    ['e', { x: 0, y: 4 }],
    ['s', { x: 4, y: 0 }],
  ] as const)(
    'an Alt %s resize on a grid that only shifts the box still commits',
    (dir, origin) => {
      const { ctrl, frameOf, beginResize } = setup(
        { grid: { size: 10 }, snap: false },
        [{ id: 'a', frame: f(4, 4) }],
      );
      ctrl.selection.set(['a']);
      beginResize(dir, { x: 44, y: 44 });
      ctrl.move({ x: 44, y: 44 }, { shift: false, ctrl: false, alt: true });
      ctrl.end();
      expect(frameOf('a')).toEqual(f(origin.x, origin.y, 40, 40));
    },
  );

  it('rotate publishes the live angle and commits it once', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, source, beginRotate } = setup({ rotate: true, onCommit });
    ctrl.selection.set(['a']);
    beginRotate({ x: 150, y: 120 });
    ctrl.move({ x: 120, y: 150 });
    expect(ctrl.liveFrames()?.get('a')).toEqual({
      ...f(100, 100),
      rotation: 90,
    });
    ctrl.end();
    expect(commits).toEqual([
      {
        patches: new Map([['a', { ...f(100, 100), rotation: 90 }]]),
        mode: 'rotate',
        container: null,
        items: source(),
      },
    ]);
  });

  it('a move publishes participant frames live, and null once idle', () => {
    const { ctrl, beginMove } = setup();
    expect(ctrl.liveFrames()).toBeNull();
    beginMove('a', { x: 105, y: 105 });
    ctrl.move({ x: 135, y: 125 });
    expect(ctrl.liveFrames()).toEqual(new Map([['a', f(130, 120)]]));
    ctrl.end();
    expect(ctrl.liveFrames()).toBeNull();
  });
});

describe('canvas controller: containers', () => {
  const stage = (id: string, frame: CanvasFrame): Widget => ({
    id,
    kind: 'stage',
    parent: null,
    frame,
  });
  const isContainer = (w: Widget) => w.kind === 'stage';
  const containerOf = (w: Widget) => w.parent ?? null;

  it('a container whose canContain refuses is not a drop target', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, beginMove } = setup(
      {
        containers: { isContainer, canContain: (c) => c.id !== 'stage2' },
        onCommit,
      },
      [stage('stage2', f(300, 0, 200, 200)), { id: 'a', frame: f(0, 0) }],
    );
    beginMove('a', { x: 5, y: 5 });
    ctrl.move({ x: 355, y: 5 });
    expect(ctrl.session.hoverContainer()).toBeNull();
    ctrl.end();
    expect(commits[0].container).toBeNull();
  });

  it('a group is accepted only if every member is', () => {
    const { ctrl, beginMove } = setup(
      {
        containers: {
          isContainer,
          canContain: (c, item) => !(c.id === 'stage2' && item.id === 'x'),
        },
        snap: false,
      },
      [
        stage('stage2', f(300, 0, 200, 200)),
        { id: 'a', frame: f(0, 0) },
        { id: 'x', frame: f(0, 100) },
      ],
    );
    ctrl.selection.set(['a', 'x']);
    beginMove('a', { x: 5, y: 5 });
    ctrl.move({ x: 355, y: 5 });
    expect(ctrl.session.hoverContainer()).toBeNull();
    ctrl.cancel();
  });

  describe('reparent rebasing', () => {
    const reparentSetup = (items: Widget[], extra = {}) => {
      const reparents: CanvasReparentEvent<Widget, string>[] = [];
      const { commits, onCommit } = commitsOf();
      const s = setup(
        {
          containers: { isContainer, containerOf, ...extra },
          onReparent: (e) => reparents.push(e),
          onCommit,
          snap: false,
        },
        items,
      );
      return { ...s, reparents, commits };
    };
    const nested: Widget[] = [
      stage('stage1', f(40, 30, 200, 200)),
      stage('stage2', f(300, 60, 200, 200)),
      { id: 'a', parent: 'stage1', frame: f(60, 60) },
    ];

    it('shifts by the start container origin minus the target origin, on both axes', () => {
      const { ctrl, beginMove, reparents } = reparentSetup(nested);
      beginMove('a', { x: 65, y: 65 });
      ctrl.move({ x: 365, y: 85 });
      expect(ctrl.session.hoverContainer()).toBe('stage2');
      ctrl.end();
      expect(reparents[0].container).toBe('stage2');
      expect(reparents[0].patches.get('a')).toEqual(f(100, 50));
    });

    it('a drop on empty canvas reparents to the root with the start origin added', () => {
      const { ctrl, beginMove, reparents } = reparentSetup(nested);
      beginMove('a', { x: 65, y: 65 });
      ctrl.move({ x: 665, y: 385 });
      ctrl.end();
      expect(reparents[0].container).toBeNull();
      expect(reparents[0].patches.get('a')).toEqual(f(700, 410));
    });

    it('a start container that refuses the item still supplies its origin', () => {
      const { ctrl, beginMove, reparents } = reparentSetup(
        [
          stage('stage1', f(100, 0, 150, 200)),
          stage('stage2', f(300, 0, 200, 200)),
          { id: 'a', parent: 'stage1', frame: f(20, 20) },
        ],
        { canContain: (c: Widget) => c.id !== 'stage1' },
      );
      beginMove('a', { x: 25, y: 25 });
      ctrl.move({ x: 325, y: 25 });
      ctrl.end();
      expect(reparents[0].patches.get('a')).toEqual(f(120, 20));
    });

    it('a group where only some members change container reparents', () => {
      const { ctrl, beginMove, reparents, commits } = reparentSetup([
        stage('stage1', f(0, 0, 200, 200)),
        { id: 'a', parent: 'stage1', frame: f(50, 50) },
        { id: 'b', parent: null, frame: f(300, 300) },
      ]);
      ctrl.selection.set(['a', 'b']);
      beginMove('a', { x: 55, y: 55 });
      ctrl.move({ x: 65, y: 55 });
      ctrl.end();
      expect(reparents).toHaveLength(1);
      expect(reparents[0].container).toBe('stage1');
      expect(commits).toHaveLength(0);
    });
  });

  it('a chain that runs into a cycle above the moving items terminates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { commits, onCommit } = commitsOf();
      const { ctrl, frameOf, beginMove } = setup(
        { containers: { isContainer, containerOf }, snap: false, onCommit },
        [
          { id: 'A', kind: 'stage', parent: 'B', frame: f(0, 0, 50, 50) },
          { id: 'B', kind: 'stage', parent: 'A', frame: f(100, 0, 50, 50) },
          { id: 'C', parent: 'A', frame: f(200, 0) },
          { id: 'X', parent: null, frame: f(300, 300) },
        ],
      );
      ctrl.selection.set(['C', 'X']);
      expect(beginMove('X', { x: 305, y: 305 })).toBe(true);
      ctrl.move({ x: 325, y: 305 });
      ctrl.end();
      expect([...commits[0].patches.keys()]).toEqual(['C', 'X']);
      expect(frameOf('C')).toMatchObject({ x: 220 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a parent key missing from the items ends the chain: the child rides, no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { commits, onCommit } = commitsOf();
      const { ctrl } = setup(
        { containers: { isContainer, containerOf }, onCommit },
        [
          { id: 'P', kind: 'stage', parent: 'ghost', frame: f(0, 0, 100, 100) },
          { id: 'k', parent: 'P', frame: f(10, 10) },
        ],
      );
      ctrl.selection.set(['P', 'k']);
      expect(ctrl.nudge(1, 0, false)).toBe(true);
      expect([...commits[0].patches.keys()]).toEqual(['P']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
