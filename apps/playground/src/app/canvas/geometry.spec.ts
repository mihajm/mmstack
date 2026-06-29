import {
  clamp,
  clampBox,
  clampPoint,
  intersects,
  normalizeRect,
  snapToGrid,
} from './geometry';

describe('geometry', () => {
  describe('snapToGrid', () => {
    it('snaps to the nearest uniform grid intersection', () => {
      expect(snapToGrid({ x: 12, y: 18 }, { size: 10 })).toEqual({ x: 10, y: 20 });
      expect(snapToGrid({ x: 16, y: 4 }, { size: 10 })).toEqual({ x: 20, y: 0 });
    });

    it('supports per-axis size and an offset origin', () => {
      expect(snapToGrid({ x: 13, y: 13 }, { size: { x: 10, y: 5 } })).toEqual({
        x: 10,
        y: 15,
      });
      expect(snapToGrid({ x: 13, y: 0 }, { size: 10, offset: { x: 5, y: 0 } })).toEqual({
        x: 15,
        y: 0,
      });
    });

    it('passes through when an axis size is 0', () => {
      expect(snapToGrid({ x: 7, y: 7 }, { size: 0 })).toEqual({ x: 7, y: 7 });
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

  describe('intersects', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    it('detects overlap and separation', () => {
      expect(intersects(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
      expect(intersects(a, { x: 20, y: 0, width: 5, height: 5 })).toBe(false);
    });
    it('treats edge-only touching as non-overlapping', () => {
      expect(intersects(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
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
});
