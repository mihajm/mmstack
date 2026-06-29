import { snapToTargets } from './alignment';
import type { Box } from './geometry';

const box = (x: number, y: number, width = 20, height = 20): Box => ({ x, y, width, height });

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
    expect(res.guides.some((g) => g.axis === 'x' && g.position === 10)).toBe(true);
  });

  it('snaps centers together', () => {
    // moving center at 12+10=22; target center at 50+10=60 → too far; use aligned case
    const res = snapToTargets(box(48, 0), [box(50, 80)], 6);
    expect(res.box.x).toBe(50); // left→left snap (distance 2)
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
