import {
  boxContainsPoint,
  clamp,
  clampBox,
  clampPoint,
  containsBox,
  gridStep,
  intersects,
  normalizeRect,
  snapToGrid,
  unionBox,
} from './geometry';

describe('canvas geometry', () => {
  describe('snapToGrid', () => {
    it('snaps to the nearest uniform grid intersection', () => {
      expect(snapToGrid({ x: 12, y: 18 }, { size: 10 })).toEqual({
        x: 10,
        y: 20,
      });
      expect(snapToGrid({ x: 16, y: 4 }, { size: 10 })).toEqual({
        x: 20,
        y: 0,
      });
    });

    it('supports per-axis size and an offset origin', () => {
      expect(snapToGrid({ x: 13, y: 13 }, { size: { x: 10, y: 5 } })).toEqual({
        x: 10,
        y: 15,
      });
      expect(
        snapToGrid({ x: 13, y: 0 }, { size: 10, offset: { x: 5, y: 0 } }),
      ).toEqual({ x: 15, y: 0 });
    });

    it('applies the y offset like the x offset', () => {
      expect(
        snapToGrid({ x: 0, y: 13 }, { size: 10, offset: { x: 0, y: 5 } }),
      ).toEqual({ x: 0, y: 15 });
    });

    it('passes through when an axis size is 0', () => {
      expect(snapToGrid({ x: 7, y: 7 }, { size: 0 })).toEqual({ x: 7, y: 7 });
    });
  });

  describe('gridStep', () => {
    it('reads the x step, defaulting to 1 with no grid', () => {
      expect(gridStep(undefined)).toBe(1);
      expect(gridStep({ size: 8 })).toBe(8);
      expect(gridStep({ size: { x: 4, y: 12 } })).toBe(4);
    });
  });

  describe('normalizeRect', () => {
    it('builds a non-negative box from any two corners', () => {
      expect(normalizeRect({ x: 10, y: 10 }, { x: 4, y: 25 })).toEqual({
        x: 4,
        y: 10,
        width: 6,
        height: 15,
      });
    });
  });

  describe('intersects / containsBox / boxContainsPoint', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };

    it('detects overlap and separation', () => {
      expect(intersects(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
      expect(intersects(a, { x: 20, y: 0, width: 5, height: 5 })).toBe(false);
    });

    it('treats edge-only touching as non-overlapping', () => {
      expect(intersects(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    });

    it.each([
      ['touching on the left', { x: -5, y: 0, width: 5, height: 5 }],
      ['touching on the top', { x: 0, y: -5, width: 5, height: 5 }],
      ['touching on the bottom', { x: 0, y: 10, width: 5, height: 5 }],
      ['entirely above', { x: 2, y: -20, width: 5, height: 5 }],
      ['entirely below', { x: 2, y: 20, width: 5, height: 5 }],
    ])('does not intersect a box %s', (_name, b) => {
      expect(intersects(a, b)).toBe(false);
      expect(intersects(b, a)).toBe(false);
    });

    it.each([
      ['left', { x: -1, y: 2, width: 5, height: 5 }],
      ['top', { x: 2, y: -1, width: 5, height: 5 }],
      ['bottom', { x: 2, y: 2, width: 8, height: 9 }],
    ])('containsBox rejects an inner box poking out on the %s', (_s, b) => {
      expect(containsBox(a, b)).toBe(false);
    });

    it('boxContainsPoint rejects points just above or below', () => {
      expect(boxContainsPoint(a, 5, -0.1)).toBe(false);
      expect(boxContainsPoint(a, 5, 10.1)).toBe(false);
      expect(boxContainsPoint(a, -0.1, 5)).toBe(false);
    });

    it('containsBox requires full containment (edges inclusive)', () => {
      expect(containsBox(a, { x: 2, y: 2, width: 8, height: 8 })).toBe(true);
      expect(containsBox(a, { x: 2, y: 2, width: 9, height: 8 })).toBe(false);
      expect(containsBox(a, a)).toBe(true);
    });

    it('boxContainsPoint is edge-inclusive', () => {
      expect(boxContainsPoint(a, 0, 0)).toBe(true);
      expect(boxContainsPoint(a, 10, 10)).toBe(true);
      expect(boxContainsPoint(a, 10.1, 5)).toBe(false);
    });
  });

  describe('clamp helpers', () => {
    it('clamp clamps a scalar', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });

    it('clampPoint keeps a point inside bounds', () => {
      const b = { x: 0, y: 0, width: 100, height: 50 };
      expect(clampPoint({ x: 120, y: -10 }, b)).toEqual({ x: 100, y: 0 });
    });

    it('clampBox keeps a box fully inside, preserving size', () => {
      const b = { x: 0, y: 0, width: 100, height: 100 };
      expect(clampBox({ x: 90, y: 90, width: 20, height: 20 }, b)).toEqual({
        x: 80,
        y: 80,
        width: 20,
        height: 20,
      });
    });
  });

  describe('unionBox', () => {
    it('is null for an empty set and the box itself for one', () => {
      expect(unionBox([])).toBeNull();
      const b = { x: 3, y: 4, width: 5, height: 6 };
      expect(unionBox([b])).toEqual(b);
    });

    it('bounds a scattered set', () => {
      expect(
        unionBox([
          { x: 0, y: 10, width: 10, height: 10 },
          { x: 30, y: 0, width: 5, height: 40 },
        ]),
      ).toEqual({ x: 0, y: 0, width: 35, height: 40 });
    });

    it('does not depend on the order of the boxes', () => {
      const boxes = [
        { x: 30, y: 0, width: 5, height: 40 },
        { x: 0, y: 10, width: 10, height: 10 },
        { x: 12, y: -4, width: 3, height: 3 },
      ];
      const expected = { x: 0, y: -4, width: 35, height: 44 };
      expect(unionBox(boxes)).toEqual(expected);
      expect(unionBox([...boxes].reverse())).toEqual(expected);
    });

    it('measures the far edges from x + width and y + height', () => {
      expect(
        unionBox([
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 5, y: 2, width: 10, height: 10 },
        ]),
      ).toEqual({ x: 0, y: 0, width: 15, height: 12 });
    });
  });
});
