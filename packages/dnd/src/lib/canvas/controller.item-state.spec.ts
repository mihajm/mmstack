import { signal } from '@angular/core';

import {
  canvas,
  type CanvasCommitEvent,
  type CanvasOptions,
} from './controller';
import type { CanvasFrame } from './geometry';

type Widget = { id: string; frame: CanvasFrame };

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
  ctrl.setSurface({
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLElement);
  const els = new Map<string, HTMLElement>();
  for (const it of items) {
    const el = {
      getBoundingClientRect: () => {
        const fr = source().find((i) => i.id === it.id)?.frame ?? it.frame;
        return { left: fr.x, top: fr.y, width: fr.width, height: fr.height };
      },
    } as unknown as HTMLElement;
    els.set(it.id, el);
    ctrl.register(it.id, el);
  }
  const frameOf = (id: string) => source().find((i) => i.id === id)?.frame;
  const stateOf = (id: string) =>
    ctrl.itemState(() => source().find((i) => i.id === id) as Widget);
  return { source, ctrl, els, frameOf, stateOf };
}

describe('canvas itemState', () => {
  it('idle: the frame box, no transform for an unrotated item, not selected', () => {
    const { ctrl, stateOf } = setup();
    const b = stateOf('b');
    expect([b.leftPx(), b.topPx(), b.widthPx(), b.heightPx()]).toEqual([
      200, 100, 40, 40,
    ]);
    expect(b.transformCss()).toBe('');
    expect(b.participating()).toBe(false);
    expect(b.selected()).toBe(false);
    ctrl.selection.set(['b']);
    expect(b.selected()).toBe(true);
  });

  it('a move translates the participant only, on a single axis too', () => {
    const { ctrl, els, stateOf } = setup();
    const a = stateOf('a');
    const b = stateOf('b');
    ctrl.beginFromPress(
      { mode: 'move', itemEl: els.get('a') as HTMLElement },
      { x: 105, y: 105 },
      false,
    );
    ctrl.move({ x: 130, y: 105 });
    expect(a.participating()).toBe(true);
    expect(b.participating()).toBe(false);
    expect(a.transformCss()).toBe('translate(25px, 0px)');
    expect(b.transformCss()).toBe('');
    ctrl.end();
    expect(a.participating()).toBe(false);
    expect(a.transformCss()).toBe('');
  });

  it('nobody participates in a marquee', () => {
    const { ctrl, stateOf } = setup();
    const a = stateOf('a');
    ctrl.beginFromPress({ mode: 'marquee' }, { x: 0, y: 0 }, false);
    ctrl.move({ x: 500, y: 500 });
    expect(ctrl.selection.ids()).toEqual(['a', 'b', 'c']);
    expect(a.participating()).toBe(false);
    ctrl.end();
  });

  it.each([
    ['se', { x: 140, y: 140 }, { x: 160, y: 150 }, [100, 100, 60, 50]],
    ['nw', { x: 100, y: 100 }, { x: 90, y: 80 }, [90, 80, 50, 60]],
  ] as const)('a %s resize renders the live box', (dir, from, to, box) => {
    const { ctrl, stateOf } = setup();
    const a = stateOf('a');
    const b = stateOf('b');
    ctrl.selection.set(['a']);
    ctrl.beginFromPress({ mode: 'resize', direction: dir }, from, false);
    ctrl.move(to);
    expect([a.leftPx(), a.topPx(), a.widthPx(), a.heightPx()]).toEqual(box);
    expect([b.leftPx(), b.topPx(), b.widthPx(), b.heightPx()]).toEqual([
      200, 100, 40, 40,
    ]);
    ctrl.cancel();
    expect([a.leftPx(), a.topPx(), a.widthPx(), a.heightPx()]).toEqual([
      100, 100, 40, 40,
    ]);
  });

  it('rotation renders idle, and the live angle only on the rotating item', () => {
    const { ctrl, stateOf } = setup({ rotate: true }, [
      { id: 'a', frame: { ...f(100, 100), rotation: 30 } },
      { id: 'b', frame: { ...f(200, 100), rotation: 10 } },
      { id: 'c', frame: f(300, 300) },
    ]);
    const a = stateOf('a');
    const b = stateOf('b');
    expect(a.transformCss()).toBe('rotate(30deg)');
    ctrl.selection.set(['a']);
    ctrl.beginFromPress({ mode: 'rotate' }, { x: 150, y: 120 }, false);
    ctrl.move({ x: 120, y: 150 });
    expect(a.transformCss()).toBe('rotate(120deg)');
    expect(b.transformCss()).toBe('rotate(10deg)');
    ctrl.cancel();

    const c = stateOf('c');
    ctrl.selection.set(['c']);
    ctrl.beginFromPress({ mode: 'rotate' }, { x: 350, y: 320 }, false);
    ctrl.move({ x: 320, y: 350 });
    expect(c.transformCss()).toBe('rotate(90deg)');
    ctrl.cancel();
  });
});

describe('canvas press', () => {
  it('a locked item cannot be selected by a press', () => {
    const { ctrl } = setup({ lockedKeys: signal(new Set(['a'])) });
    ctrl.press('a', false);
    ctrl.press('a', true);
    expect(ctrl.selection.ids()).toEqual([]);
  });

  it('a plain press replaces the selection; pressing again keeps it', () => {
    const { ctrl } = setup();
    ctrl.selection.set(['a', 'b']);
    ctrl.press('c', false);
    expect(ctrl.selection.ids()).toEqual(['c']);
    ctrl.press('c', false);
    expect(ctrl.selection.ids()).toEqual(['c']);
  });
});

describe('canvas nudge and nudgeResize', () => {
  const commitsOf = () => {
    const commits: CanvasCommitEvent<Widget, string>[] = [];
    return {
      commits,
      onCommit: (e: CanvasCommitEvent<Widget, string>) => commits.push(e),
    };
  };

  it('an empty selection commits nothing', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl } = setup({ onCommit });
    expect(ctrl.nudge(1, 0, false)).toBe(false);
    expect(commits).toHaveLength(0);
  });

  it('locked selected items stay put while the rest nudges', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl, frameOf } = setup({
      onCommit,
      lockedKeys: signal(new Set(['b'])),
    });
    ctrl.selection.set(['a', 'b']);
    expect(ctrl.nudge(1, 0, false)).toBe(true);
    expect([...commits[0].patches.keys()]).toEqual(['a']);
    expect(frameOf('a')?.x).toBe(101);
    expect(frameOf('b')?.x).toBe(200);
  });

  it('canTransform(keyboard) gates nudge and nudgeResize', () => {
    const { ctrl, frameOf } = setup({
      canTransform: (_item, mode) => mode !== 'keyboard',
    });
    ctrl.selection.set(['a']);
    expect(ctrl.nudge(1, 0, false)).toBe(false);
    expect(ctrl.nudgeResize(1, 1, false)).toBe(false);
    expect(frameOf('a')).toEqual(f(100, 100));
  });

  it('a locked single selection is not resized from the keyboard', () => {
    const { ctrl, frameOf } = setup({ lockedKeys: signal(new Set(['a'])) });
    ctrl.selection.set(['a']);
    expect(ctrl.nudgeResize(1, 1, false)).toBe(false);
    expect(frameOf('a')).toEqual(f(100, 100));
  });

  it('a vertical nudge clamps on the y axis and moves freely inside the bounds', () => {
    const tight = setup({
      grid: { size: 8 },
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
    tight.ctrl.selection.set(['a']);
    expect(tight.ctrl.nudge(0, 1, true)).toBe(true);
    expect(tight.frameOf('a')?.y).toBe(160);

    const roomy = setup({
      grid: { size: 8 },
      bounds: { x: 0, y: 0, width: 1000, height: 1000 },
    });
    roomy.ctrl.selection.set(['a']);
    expect(roomy.ctrl.nudge(0, 1, false)).toBe(true);
    expect(roomy.frameOf('a')?.y).toBe(108);
  });

  it('a keyboard resize commits with mode keyboard', () => {
    const { commits, onCommit } = commitsOf();
    const { ctrl } = setup({ onCommit });
    ctrl.selection.set(['a']);
    expect(ctrl.nudgeResize(1, 0, false)).toBe(true);
    expect(commits[0].mode).toBe('keyboard');
    expect(commits[0].patches.get('a')).toEqual(f(100, 100, 41, 40));
  });
});
