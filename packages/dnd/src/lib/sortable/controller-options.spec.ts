import { signal } from '@angular/core';
import { type Handle } from '@mmstack/primitives';

import { type DragGeometry } from './session';
import { reorderable } from './controller';
import type { ReorderableOptions } from './types';

type Task = { id: number; label: string };
const DATA: Task[] = [1, 2, 3, 4, 5].map((id) => ({
  id,
  label: String.fromCharCode(96 + id),
}));
const geom = (source: number, axis: 'x' | 'y' = 'y'): DragGeometry => ({
  source,
  centers: [10, 30, 50, 70, 90],
  footprint: 20,
  axis,
});
const make = (opts: Partial<ReorderableOptions<Task, number>> = {}) => {
  const data = signal(DATA.slice());
  const ctrl = reorderable(data, {
    key: (t) => t.id,
    ...opts,
  } as ReorderableOptions<Task, number>);
  const at = (i: number) => ctrl.itemState(() => data()[i]);
  return { data, ctrl, at };
};

describe('reorderable options: documented defaults', () => {
  it('axis defaults to y', () => {
    expect(make().ctrl.axis).toBe('y');
  });

  it.each([
    [undefined, 33, 0],
    [0, 33, 1],
    [10, 38, 0],
    [10, 41, 1],
  ])('deadband %s: a pointer at %s gives insert %s', (deadband, y, insert) => {
    const { ctrl } = make(deadband === undefined ? {} : { deadband });
    ctrl.begin(1, geom(0), 10);
    ctrl.move({ x: 0, y });
    expect(ctrl.insertIndex()).toBe(insert);
  });

  it('animation defaults to 200ms with the decelerate easing; each field defaults alone', () => {
    const easing = 'cubic-bezier(0.2, 0, 0, 1)';
    expect(make().ctrl.animation).toEqual({ duration: 200, easing });
    expect(make({ animation: { duration: 300 } }).ctrl.animation).toEqual({
      duration: 300,
      easing,
    });
    expect(make({ animation: { easing: 'linear' } }).ctrl.animation).toEqual({
      duration: 200,
      easing: 'linear',
    });
  });

  it('animation: false resolves to null and siblings reflow without a transition', () => {
    const { ctrl, at } = make({ animation: false });
    expect(ctrl.animation).toBeNull();
    ctrl.begin(1, geom(0), 10);
    ctrl.move({ x: 0, y: 55 });
    expect(at(2).transform()).toBe(-20);
    expect(at(2).transitionCss()).toBe('none');
  });

  it('autoScroll is off by default; an opt-in fills edge 48 / speed 16 and keeps explicit values', () => {
    expect(make().ctrl.autoScroll).toBeNull();
    expect(make({ autoScroll: false }).ctrl.autoScroll).toBeNull();
    expect(make({ autoScroll: {} }).ctrl.autoScroll).toMatchObject({
      edge: 48,
      speed: 16,
    });
    expect(
      make({ autoScroll: { edge: 10, speed: 5, maxSpeedAt: 0.3 } }).ctrl
        .autoScroll,
    ).toMatchObject({ edge: 10, speed: 5, maxSpeedAt: 0.3 });
  });

  it('the jump modifier is Ctrl off macOS', () => {
    const { ctrl } = make();
    expect(
      ctrl.jumpModifier(new KeyboardEvent('keydown', { ctrlKey: true })),
    ).toBe(true);
    expect(
      ctrl.jumpModifier(new KeyboardEvent('keydown', { metaKey: true })),
    ).toBe(false);
  });

  it('the jump modifier is Cmd on macOS', () => {
    const platform = vi
      .spyOn(navigator, 'platform', 'get')
      .mockReturnValue('MacIntel');
    try {
      const { ctrl } = make();
      expect(
        ctrl.jumpModifier(new KeyboardEvent('keydown', { metaKey: true })),
      ).toBe(true);
      expect(
        ctrl.jumpModifier(new KeyboardEvent('keydown', { ctrlKey: true })),
      ).toBe(false);
    } finally {
      platform.mockRestore();
    }
  });
});

describe('reorderable options: dev warnings for an engine flipped under an option', () => {
  const insert = { accepts: () => true, create: () => DATA[0] };
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ['plain list', {}, null],
    ['native + insert', { insert }, null],
    ['pointer + insert', { engine: 'pointer', insert }, 'insert'],
    [
      'pointer + onItemInserted',
      { engine: 'pointer', onItemInserted: () => undefined },
      'onItemInserted',
    ],
    [
      'native + activationThreshold',
      { activationThreshold: 8 },
      'activationThreshold',
    ],
    [
      'pointer + activationThreshold',
      { engine: 'pointer', activationThreshold: 8 },
      null,
    ],
    ['native + touchActivation', { touchActivation: true }, 'touchActivation'],
    ['wrap, engine left to the default', { axis: 'wrap' }, "'wrap'"],
    ['wrap + pointer', { axis: 'wrap', engine: 'pointer' }, null],
  ];

  it.each(cases)('%s', (_name, opts, warned) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      make(opts as Partial<ReorderableOptions<Task, number>>);
      if (warned === null) expect(warn).not.toHaveBeenCalled();
      else {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(warned);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe('reorderable: an x-axis list', () => {
  it('collides on x, displaces along x and renders translateX', () => {
    const { ctrl, at } = make({ axis: 'x' });
    ctrl.begin(1, geom(0, 'x'), 10);
    ctrl.move({ x: 55, y: 0 });
    expect(ctrl.insertIndex()).toBe(2);
    expect(at(2).transform()).toBe(-20);
    expect(at(2).transformX()).toBe(-20);
    expect(at(2).transformY()).toBe(0);
    expect(at(2).transformCss()).toBe('translateX(-20px)');
    expect(at(0).transformCss()).toBe('translateX(45px)');
  });

  it('a y list maps its scalar to transformY only', () => {
    const { ctrl, at } = make();
    ctrl.begin(1, geom(0), 10);
    ctrl.move({ x: 0, y: 55 });
    expect(at(2).transformY()).toBe(-20);
    expect(at(2).transformX()).toBe(0);
  });
});

describe('reorderable: auto-scroll compensation', () => {
  it('the scroll travelled since drag start counts toward the insert and the follow', () => {
    const { ctrl, at } = make();
    ctrl.begin(1, geom(0), 10);
    ctrl.setScrollDelta(20);
    ctrl.move({ x: 0, y: 40 });
    expect(ctrl.insertIndex()).toBe(2);
    expect(at(0).transform()).toBe(50);
    expect(at(0).transformCss()).toBe('translateY(50px)');
  });
});

describe('reorderable: item state at rest and after a drop', () => {
  it('itemKey is the row key; a row not in the list reads index -1 and never moves', () => {
    const { ctrl, at } = make();
    expect(at(2).itemKey()).toBe(3);
    const ghost = ctrl.itemState(() => ({ id: 99, label: 'z' }));
    ctrl.begin(1, geom(0), 10);
    ctrl.move({ x: 0, y: 55 });
    expect(ghost.index()).toBe(-1);
    expect(ghost.transform()).toBe(0);
  });

  it('a drag to the top opens the gap at 0', () => {
    const { ctrl, at } = make();
    ctrl.begin(3, geom(2), 50);
    ctrl.move({ x: 0, y: 5 });
    expect(ctrl.insertIndex()).toBe(0);
    expect(at(0).transform()).toBe(20);
    expect(at(1).transform()).toBe(20);
  });

  it('the source renders no transform at zero offset', () => {
    const { ctrl, at } = make();
    ctrl.begin(1, geom(0), 10);
    expect(at(0).transformCss()).toBe('');
  });

  it('rows glide only while their list takes part in a drag: none at rest and again after the drop', () => {
    const { ctrl, at } = make();
    expect(at(2).transitionCss()).toBe('none');
    ctrl.begin(1, geom(0), 10);
    ctrl.move({ x: 0, y: 55 });
    expect(at(2).transitionCss()).toContain('transform');
    ctrl.end();
    expect(at(2).transitionCss()).toBe('none');
  });
});

describe('reorderable: moveItem guards and events', () => {
  it.each([
    [0, -1],
    [5, 0],
    [1, 1],
    [-1, 0],
  ])('moveItem(%s, %s) writes nothing and fires nothing', (from, to) => {
    const onReorder = vi.fn();
    const { data, ctrl } = make({ onReorder });
    const before = data();
    ctrl.moveItem(from, to);
    expect(data()).toBe(before);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('a move past the end lands last and the event names the moved item', () => {
    const onReorder = vi.fn();
    const { data, ctrl } = make({ onReorder });
    ctrl.moveItem(0, 99);
    expect(data().map((t) => t.id)).toEqual([2, 3, 4, 5, 1]);
    expect(onReorder.mock.calls[0][0]).toMatchObject({
      moved: 1 as Handle<number>,
      anchor: { after: 5 },
    });
  });
});
