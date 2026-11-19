import type { Box } from './geometry';
import { nearestEdge, snapResizeBox, snapToTargets } from './snap';

const box = (x: number, y: number, width = 20, height = 20): Box => ({
  x,
  y,
  width,
  height,
});

describe('snapToTargets', () => {
  it('returns the box unchanged with no targets', () => {
    const b = box(13, 13);
    const res = snapToTargets(b, []);
    expect(res.box).toEqual(b);
    expect(res.guides).toEqual([]);
  });

  it('snaps a left edge to a target left edge within threshold', () => {
    const res = snapToTargets(box(12, 100), [box(10, 0)], 6);
    expect(res.box.x).toBe(10);
    expect(res.guides.some((g) => g.axis === 'x' && g.position === 10)).toBe(
      true,
    );
  });

  it('snaps centers together', () => {
    // only the centers are close: 110 vs 112
    const res = snapToTargets(box(100, 0), [box(92, 100, 40, 40)], 6);
    expect(res.box.x).toBe(102);
    expect(res.guides).toContainEqual({
      axis: 'x',
      position: 112,
      from: 0,
      to: 140,
    });
  });

  it('snaps vertical centers together', () => {
    const res = snapToTargets(box(0, 100), [box(100, 92, 40, 40)], 6);
    expect(res.box.y).toBe(102);
    expect(res.guides).toContainEqual({
      axis: 'y',
      position: 112,
      from: 0,
      to: 140,
    });
  });

  it('snaps a bottom edge to a target bottom edge', () => {
    // only the bottoms are close: 120 vs 123
    const res = snapToTargets(box(500, 100), [box(0, 23, 10, 100)], 6);
    expect(res.box.y).toBe(103);
  });

  it('the threshold is inclusive', () => {
    const target = box(10, 0, 100, 100);
    expect(snapToTargets(box(16, 500), [target], 6).box.x).toBe(10);
  });

  it('the nearest candidate wins, wherever it is listed', () => {
    const near = box(102, 500, 20, 20);
    const far = box(105, 800, 20, 20);
    expect(snapToTargets(box(100, 0), [near, far], 6).box.x).toBe(102);
    expect(snapToTargets(box(100, 0), [far, near], 6).box.x).toBe(102);
  });

  it('merges guides that share a line into one spanning all of them', () => {
    const above = box(100, 0, 20, 20);
    const below = box(100, 200, 20, 20);
    const res = snapToTargets(box(100, 100), [above, below], 6);
    expect(res.guides.filter((g) => g.axis === 'x')).toEqual([
      { axis: 'x', position: 100, from: 0, to: 220 },
      { axis: 'x', position: 110, from: 0, to: 220 },
      { axis: 'x', position: 120, from: 0, to: 220 },
    ]);
  });

  it('an exact overlay of a target yields three guides per axis', () => {
    const res = snapToTargets(box(10, 10), [box(10, 10)], 6);
    expect(res.guides.filter((g) => g.axis === 'x')).toHaveLength(3);
    expect(res.guides.filter((g) => g.axis === 'y')).toHaveLength(3);
  });

  it('a target below spans the guide to its bottom', () => {
    const res = snapToTargets(box(10, 0), [box(10, 100)], 6);
    expect(res.guides.find((g) => g.axis === 'x')).toEqual({
      axis: 'x',
      position: 10,
      from: 0,
      to: 120,
    });
  });

  it('emits a horizontal guide for aligned tops', () => {
    const res = snapToTargets(box(100, 10, 20, 20), [box(0, 10, 40, 40)], 6);
    expect(res.guides).toContainEqual({
      axis: 'y',
      position: 10,
      from: 0,
      to: 120,
    });
  });

  it('does not snap when all edges are beyond the threshold', () => {
    const res = snapToTargets(box(20, 500, 20, 20), [box(100, 0, 5, 5)], 6);
    expect(res.box).toEqual(box(20, 500, 20, 20));
    expect(res.guides).toEqual([]);
  });

  it('snaps to canvas edges when provided', () => {
    const canvas = box(0, 0, 500, 400);
    const res = snapToTargets(box(3, 200), [], 6, canvas);
    expect(res.box.x).toBe(0); // left edge → canvas left
  });

  it('produces a vertical guide spanning both boxes', () => {
    const res = snapToTargets(box(10, 100, 20, 20), [box(10, 0, 20, 20)], 6);
    const g = res.guides.find((g) => g.axis === 'x');
    expect(g).toBeDefined();
    expect(g?.from).toBe(0);
    expect(g?.to).toBe(120); // from target top (0) to moving bottom (120)
  });

  it('snaps both axes independently', () => {
    const res = snapToTargets(box(12, 13), [box(10, 10)], 6);
    expect(res.box).toMatchObject({ x: 10, y: 10 });
  });
});

describe('nearestEdge', () => {
  it('finds the closest candidate within the threshold, or null', () => {
    expect(nearestEdge(103, [100, 110], 6)).toBe(100);
    expect(nearestEdge(107, [100, 110], 6)).toBe(110);
    expect(nearestEdge(50, [100, 110], 6)).toBeNull();
    expect(nearestEdge(5, [], 6)).toBeNull();
  });

  it('picks the nearer of two candidates in range, whatever the order', () => {
    expect(nearestEdge(104, [102, 108], 6)).toBe(102);
    expect(nearestEdge(104, [108, 102], 6)).toBe(102);
  });
});

describe('snapResizeBox: only the moving edges snap', () => {
  const b = (x: number, y: number, width: number, height: number): Box => ({
    x,
    y,
    width,
    height,
  });

  it('snaps to the canvas edges when a canvas box is given', () => {
    const r = snapResizeBox(b(0, 0, 97, 50), 'e', [], 6, b(0, 0, 100, 400));
    expect(r.box).toEqual(b(0, 0, 100, 50));
  });

  it.each([
    ['center', b(33, 300, 40, 10)],
    ['right edge', b(0, 300, 53, 10)],
  ])('an east edge snaps to a target %s', (_name, target) => {
    expect(snapResizeBox(b(0, 0, 50, 50), 'e', [target], 6).box.width).toBe(53);
  });

  it.each([
    ['top', b(300, 53, 10, 100)],
    ['center', b(300, 13, 10, 80)],
    ['bottom', b(300, 0, 10, 53)],
  ])('a south edge snaps to a target %s', (_name, target) => {
    expect(snapResizeBox(b(0, 0, 50, 50), 's', [target], 6).box).toEqual(
      b(0, 0, 50, 53),
    );
  });

  it('a west edge snaps its left side, moving the origin', () => {
    const r = snapResizeBox(b(100, 0, 50, 50), 'w', [b(0, 300, 97, 10)], 6);
    expect(r.box).toEqual(b(97, 0, 53, 50));
  });

  it('a north edge snaps its top side, moving the origin', () => {
    const r = snapResizeBox(b(0, 100, 50, 50), 'n', [b(300, 0, 10, 97)], 6);
    expect(r.box).toEqual(b(0, 97, 50, 53));
  });

  it.each([
    ['w', 'right', b(100, 0, 50, 50), b(153, 300, 10, 10)],
    ['n', 'left', b(100, 0, 50, 50), b(0, 300, 97, 10)],
    ['e', 'bottom', b(0, 0, 50, 50), b(300, 53, 10, 10)],
    ['e', 'top', b(0, 100, 50, 50), b(300, 90, 10, 7)],
  ] as const)(
    'a %s resize leaves the %s edge alone even near a target',
    (dir, _edge, box, target) => {
      expect(snapResizeBox(box, dir, [target], 6).box).toEqual(box);
    },
  );
});

describe('snapResizeBox', () => {
  it('snaps the resized east edge to a sibling edge and emits a guide', () => {
    const r = snapResizeBox(
      { x: 0, y: 0, width: 98, height: 50 },
      'se',
      [{ x: 100, y: 0, width: 20, height: 20 }],
      6,
    );
    expect(r.box.width).toBe(100); // right 98 → target left 100
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true);
  });

  it('leaves the stationary edges put', () => {
    const r = snapResizeBox(
      { x: 10, y: 10, width: 88, height: 40 },
      'se',
      [{ x: 100, y: 0, width: 10, height: 10 }],
      6,
    );
    expect(r.box.x).toBe(10);
    expect(r.box.y).toBe(10);
  });

  it('returns the box unchanged with no targets', () => {
    const b = { x: 0, y: 0, width: 50, height: 50 };
    expect(snapResizeBox(b, 'se', [], 6).box).toEqual(b);
    expect(snapResizeBox(b, 'se', [], 6).guides).toEqual([]);
  });
});
