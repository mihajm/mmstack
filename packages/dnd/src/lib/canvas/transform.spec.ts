import type { Box } from './geometry';
import {
  angleOf,
  applyResize,
  normalizeAngle,
  resolveMove,
  resolveResize,
  resolveRotate,
} from './transform';

const BASE: Box = { x: 0, y: 0, width: 100, height: 100 };

describe('resolveMove', () => {
  it('applies the raw delta with no config', () => {
    expect(resolveMove(BASE, { x: 7, y: -3 }).box).toMatchObject({
      x: 7,
      y: -3,
      width: 100,
      height: 100,
    });
  });

  it('locks to the dominant axis when lockAxis is set', () => {
    expect(
      resolveMove(BASE, { x: 30, y: 10 }, { lockAxis: true }).box,
    ).toMatchObject({ x: 30, y: 0 });
    expect(
      resolveMove(BASE, { x: 5, y: -20 }, { lockAxis: true }).box,
    ).toMatchObject({ x: 0, y: -20 });
  });

  it('snaps the origin to the grid, bypassable', () => {
    const grid = { size: 10 };
    expect(resolveMove(BASE, { x: 13, y: 18 }, { grid }).box).toMatchObject({
      x: 10,
      y: 20,
    });
    expect(
      resolveMove(BASE, { x: 13, y: 18 }, { grid, bypassSnap: true }).box,
    ).toMatchObject({ x: 13, y: 18 });
  });

  it('snaps to sibling targets and reports guides, bypassable', () => {
    const targets = [{ x: 110, y: 0, width: 50, height: 100 }];
    const snapped = resolveMove(BASE, { x: 8, y: 0 }, { targets });
    expect(snapped.box.x).toBe(10); // right edge 108 → target left 110
    expect(snapped.guides.length).toBeGreaterThan(0);

    const bypassed = resolveMove(
      BASE,
      { x: 8, y: 0 },
      { targets, bypassSnap: true },
    );
    expect(bypassed.box.x).toBe(8);
    expect(bypassed.guides).toEqual([]);
  });

  it('clamps the box within bounds after snapping', () => {
    const bounds = { x: 0, y: 0, width: 120, height: 120 };
    expect(resolveMove(BASE, { x: 500, y: -50 }, { bounds }).box).toMatchObject(
      { x: 20, y: 0 },
    );
  });

  it('grid → snapline → bounds run in pipeline order', () => {
    // grid pulls to 10, the sibling at 12 wins over the grid via snaplines,
    // bounds then clamp the result
    const res = resolveMove(
      BASE,
      { x: 9, y: 0 },
      {
        grid: { size: 10 },
        targets: [{ x: 12, y: 0, width: 100, height: 100 }],
        bounds: { x: 0, y: 0, width: 111, height: 200 },
      },
    );
    expect(res.box.x).toBe(11); // snapline 12 → clamped by bounds (111 - 100)
  });
});

describe('resolveResize with bounds after a snap', () => {
  it('a snap that pushes an edge outside the bounds is pulled back in', () => {
    const bounds = { x: 0, y: 0, width: 150, height: 300 };
    // a target edge at 152: the resized right edge (148) snaps out to it
    const res = resolveResize(
      { x: 0, y: 0, width: 100, height: 100 },
      'e',
      { x: 48, y: 0 },
      {
        bounds,
        targets: [{ x: 152, y: 0, width: 20, height: 20 }],
        threshold: 6,
      },
    );
    expect(res.box.x + res.box.width).toBeLessThanOrEqual(150);
    expect(res.box.width).toBeGreaterThan(0);
  });
});

describe('applyResize', () => {
  it('resizes from each cardinal edge', () => {
    expect(applyResize(BASE, 'e', { x: 20, y: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: 100,
    });
    expect(applyResize(BASE, 'w', { x: 20, y: 0 })).toEqual({
      x: 20,
      y: 0,
      width: 80,
      height: 100,
    });
    expect(applyResize(BASE, 's', { x: 0, y: 30 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 130,
    });
    expect(applyResize(BASE, 'n', { x: 0, y: 30 })).toEqual({
      x: 0,
      y: 30,
      width: 100,
      height: 70,
    });
  });

  it('resizes from corners', () => {
    expect(applyResize(BASE, 'se', { x: 10, y: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 110,
      height: 110,
    });
    expect(applyResize(BASE, 'nw', { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 90,
      height: 90,
    });
  });

  it('enforces min size, anchoring the stationary edge', () => {
    expect(
      applyResize(BASE, 'e', { x: -200, y: 0 }, { min: { width: 20 } }),
    ).toEqual({ x: 0, y: 0, width: 20, height: 100 });
    // dragging the west edge past min keeps the east edge fixed at x=100
    expect(
      applyResize(BASE, 'w', { x: 200, y: 0 }, { min: { width: 20 } }),
    ).toEqual({ x: 80, y: 0, width: 20, height: 100 });
  });

  it('enforces max size', () => {
    expect(
      applyResize(BASE, 'e', { x: 1000, y: 0 }, { max: { width: 200 } }),
    ).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('snaps resized edges to a grid', () => {
    expect(
      applyResize(BASE, 'se', { x: 12, y: 8 }, { grid: { size: 10 } }),
    ).toEqual({ x: 0, y: 0, width: 110, height: 110 });
  });

  it('clamps within bounds', () => {
    expect(
      applyResize(
        BASE,
        'e',
        { x: 1000, y: 0 },
        { bounds: { x: 0, y: 0, width: 150, height: 150 } },
      ),
    ).toEqual({ x: 0, y: 0, width: 150, height: 100 });
  });

  describe('bounds that no longer contain the box', () => {
    const outside: Box = { x: 200, y: 50, width: 40, height: 40 };
    const shrunk = { x: 0, y: 0, width: 150, height: 300 };

    it('never yields a negative size: the stationary edge is not dragged to the bounds', () => {
      expect(
        applyResize(outside, 'e', { x: 0, y: 0 }, { bounds: shrunk }),
      ).toEqual(outside);
      expect(
        applyResize(outside, 'e', { x: -5, y: 0 }, { bounds: shrunk }),
      ).toEqual({
        ...outside,
        width: 35,
      });
    });

    it('an edge already outside may come in but not move further out', () => {
      expect(
        applyResize(outside, 'e', { x: 20, y: 0 }, { bounds: shrunk }),
      ).toEqual(outside);
      expect(
        applyResize(outside, 'w', { x: -300, y: 0 }, { bounds: shrunk }),
      ).toEqual({
        x: 0,
        y: 50,
        width: 240,
        height: 40,
      });
    });

    it('holds over random boxes, bounds, handles and deltas', () => {
      let seed = 7;
      const rnd = () =>
        (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
      const r = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
      for (let i = 0; i < 4000; i++) {
        const base = {
          x: r(-100, 300),
          y: r(-100, 300),
          width: r(1, 150),
          height: r(1, 150),
        };
        const bounds = {
          x: r(-50, 100),
          y: r(-50, 100),
          width: r(20, 300),
          height: r(20, 300),
        };
        const min =
          rnd() < 0.5 ? { width: r(0, 30), height: r(0, 30) } : undefined;
        const dir = dirs[r(0, dirs.length - 1)];
        const delta = { x: r(-400, 400), y: r(-400, 400) };
        const out = applyResize(base, dir, delta, {
          bounds,
          min,
          fromCenter: rnd() < 0.2,
        });
        const ctx = JSON.stringify({ base, bounds, min, dir, delta, out });
        expect([out.width >= 0 && out.height >= 0, ctx]).toEqual([true, ctx]);
        const inside = (b: Box) =>
          b.x >= bounds.x &&
          b.y >= bounds.y &&
          b.x + b.width <= bounds.x + bounds.width &&
          b.y + b.height <= bounds.y + bounds.height;
        if (
          inside(base) &&
          (!min || (min.width <= bounds.width && min.height <= bounds.height))
        )
          expect([inside(out), ctx]).toEqual([true, ctx]);
        // no edge ends further outside the bounds than it started
        const past = (b: Box) => [
          Math.max(0, bounds.x - b.x),
          Math.max(0, bounds.y - b.y),
          Math.max(0, b.x + b.width - bounds.x - bounds.width),
          Math.max(0, b.y + b.height - bounds.y - bounds.height),
        ];
        const [p0, p1] = [past(base), past(out)];
        for (let k = 0; k < 4; k++)
          expect([p1[k] <= p0[k], ctx]).toEqual([true, ctx]);
      }
    });
  });

  describe('fromCenter (Alt)', () => {
    it('mirrors an edge resize around the center', () => {
      expect(
        applyResize(BASE, 'e', { x: 10, y: 0 }, { fromCenter: true }),
      ).toEqual({ x: -10, y: 0, width: 120, height: 100 });
      expect(
        applyResize(BASE, 'n', { x: 0, y: -10 }, { fromCenter: true }),
      ).toEqual({ x: 0, y: -10, width: 100, height: 120 });
    });

    it('mirrors a corner resize on both axes', () => {
      expect(
        applyResize(BASE, 'se', { x: 10, y: 20 }, { fromCenter: true }),
      ).toEqual({ x: -10, y: -20, width: 120, height: 140 });
    });

    it('keeps the center fixed through a min clamp', () => {
      const out = applyResize(
        BASE,
        'e',
        { x: -100, y: 0 },
        { fromCenter: true, min: { width: 40 } },
      );
      expect(out.width).toBe(40);
      expect(out.x + out.width / 2).toBe(50); // original center preserved
    });
  });

  describe('aspect (Shift)', () => {
    it('a corner resize follows the dominant axis and holds the ratio', () => {
      // 2:1 base — width drives (|dx| > |dy|), height follows
      const base: Box = { x: 0, y: 0, width: 200, height: 100 };
      const out = applyResize(base, 'se', { x: 40, y: 5 }, { aspect: 2 });
      expect(out.width).toBe(240);
      expect(out.height).toBe(120);
      expect(out.x).toBe(0);
      expect(out.y).toBe(0);
    });

    it('height drives when the pointer moved mostly vertically', () => {
      const out = applyResize(BASE, 'se', { x: 5, y: 50 }, { aspect: 1 });
      expect(out.height).toBe(150);
      expect(out.width).toBe(150);
    });

    it('an edge resize grows the other axis around its center', () => {
      const out = applyResize(BASE, 'e', { x: 20, y: 0 }, { aspect: 1 });
      expect(out.width).toBe(120);
      expect(out.height).toBe(120);
      expect(out.y).toBe(-10); // vertical growth is centered
    });

    it('a nw corner anchors the se corner', () => {
      const out = applyResize(BASE, 'nw', { x: -20, y: -4 }, { aspect: 1 });
      expect(out.width).toBe(120);
      expect(out.height).toBe(120);
      expect(out.x + out.width).toBe(100); // right edge fixed
      expect(out.y + out.height).toBe(100); // bottom edge fixed
    });
  });
});

describe('resolveResize', () => {
  it('composes applyResize with sibling edge snapping and re-clamps', () => {
    const res = resolveResize(
      BASE,
      'se',
      { x: -2, y: 0 },
      {
        targets: [{ x: 104, y: 0, width: 20, height: 20 }],
        threshold: 6,
        max: { width: 103 },
      },
    );
    // right edge 98 → snaps to sibling left 104 → max clamps back to 103
    expect(res.box.width).toBe(103);
    expect(res.guides.length).toBeGreaterThan(0);
  });

  it('an aspect-locked resize skips edge snapping (a single edge would break the ratio)', () => {
    const res = resolveResize(
      BASE,
      'e',
      { x: 44, y: 0 },
      {
        aspect: 1,
        targets: [{ x: 150, y: 0, width: 20, height: 20 }], // edge 6px away
        threshold: 6,
      },
    );
    expect(res.box.width).toBe(144); // NOT pulled to 150
    expect(res.box.height).toBe(144); // ratio held
    expect(res.guides).toEqual([]);
  });

  it('bypassSnap skips both the grid and the snaplines', () => {
    const res = resolveResize(
      BASE,
      'se',
      { x: 3, y: 3 },
      {
        grid: { size: 10 },
        targets: [{ x: 104, y: 0, width: 20, height: 20 }],
        bypassSnap: true,
      },
    );
    expect(res.box).toEqual({ x: 0, y: 0, width: 103, height: 103 });
    expect(res.guides).toEqual([]);
  });
});

describe('rotation', () => {
  const C = { x: 0, y: 0 };

  it('angleOf measures degrees around a pivot', () => {
    expect(angleOf({ x: 10, y: 0 }, C)).toBe(0);
    expect(angleOf({ x: 0, y: 10 }, C)).toBe(90);
    expect(angleOf({ x: -10, y: 0 }, C)).toBe(180);
  });

  it('normalizeAngle wraps into [0, 360)', () => {
    expect(normalizeAngle(370)).toBe(10);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(360)).toBe(0);
  });

  it('resolveRotate adds the pointer sweep to the base angle', () => {
    // start pointer to the east (0°), swept to the south (90°) → +90
    expect(resolveRotate(30, 0, { x: 0, y: 10 }, C)).toBe(120);
  });

  it('snaps to increments only while snapActive', () => {
    const pointer = { x: 10, y: 4 }; // ~21.8°
    expect(resolveRotate(0, 0, pointer, C, { snap: 15 })).toBeCloseTo(21.8, 0);
    expect(
      resolveRotate(0, 0, pointer, C, { snap: 15, snapActive: true }),
    ).toBe(15);
  });
});
