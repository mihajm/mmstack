import { frontierEquals, type AppliedFrontier } from './op-sync';

describe('frontierEquals', () => {
  const f = (entries: Record<string, [number, number]>): AppliedFrontier =>
    Object.fromEntries(
      Object.entries(entries).map(([o, [p, l]]) => [o, { p, l }]),
    );

  it('equal origin sets with equal stamps are equal, regardless of key order', () => {
    expect(frontierEquals(f({}), f({}))).toBe(true);
    expect(
      frontierEquals(f({ a: [1, 0], b: [2, 3] }), f({ b: [2, 3], a: [1, 0] })),
    ).toBe(true);
  });

  it('a different stamp on any origin (physical or logical part) is unequal', () => {
    expect(frontierEquals(f({ a: [1, 0] }), f({ a: [2, 0] }))).toBe(false);
    expect(frontierEquals(f({ a: [1, 0] }), f({ a: [1, 1] }))).toBe(false);
  });

  it('an origin present on one side only is unequal, in both directions', () => {
    expect(frontierEquals(f({ a: [1, 0] }), f({ a: [1, 0], b: [1, 0] }))).toBe(
      false,
    );
    expect(frontierEquals(f({ a: [1, 0], b: [1, 0] }), f({ a: [1, 0] }))).toBe(
      false,
    );
    expect(frontierEquals(f({ a: [1, 0] }), f({ b: [1, 0] }))).toBe(false);
  });
});
