import { boxData, mapDropTargets, unboxData } from './payload';

describe('payload — box/unbox round-trips', () => {
  it('round-trips data under the private symbol', () => {
    const boxed = boxData({ id: 1 });
    expect(unboxData(boxed)).toEqual({ id: 1 });
    expect(unboxData<{ id: number }>(boxed)?.id).toBe(1);
  });
});

describe('mapDropTargets — never leaks the internal record (#5)', () => {
  it('reports undefined self-data for a no-data target', () => {
    const el = document.createElement('div');
    const mapped = mapDropTargets([{ element: el, data: {} }]);
    expect(mapped[0].element).toBe(el);
    expect(mapped[0].data).toBeUndefined();
  });

  it('reports undefined when self-data was explicitly boxed as undefined', () => {
    const el = document.createElement('div');
    const mapped = mapDropTargets([{ element: el, data: boxData(undefined) }]);
    expect(mapped[0].data).toBeUndefined();
  });

  it('does not surface the symbol-keyed wrapper even when other keys are present', () => {
    const el = document.createElement('div');
    // a hitbox edge token rides alongside; self-data is still absent
    const mapped = mapDropTargets([{ element: el, data: { __edge: 'top' } }]);
    expect(mapped[0].data).toBeUndefined();
  });

  it('unboxes real self-data', () => {
    const el = document.createElement('div');
    const mapped = mapDropTargets([
      { element: el, data: boxData({ slot: 5 }) },
    ]);
    expect(mapped[0].data).toEqual({ slot: 5 });
  });
});
