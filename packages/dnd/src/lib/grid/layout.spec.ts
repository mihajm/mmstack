import {
  canPlaceAt,
  compactGrid,
  gridCollides,
  gridRows,
  moveGridItem,
  resizeGridItem,
  validTargets,
  type GridPlacement,
} from './layout';

type Item = GridPlacement & { id: string };
const key = (i: Item) => i.id;

const it_ = (id: string, x: number, y: number, w = 2, h = 2): Item => ({
  id,
  x,
  y,
  w,
  h,
});

const byId = (items: readonly Item[], id: string) =>
  items.find((i) => i.id === id);

const overlapFree = (items: readonly Item[]) => {
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      if (gridCollides(items[a], items[b])) return false;
    }
  }
  return true;
};

// deterministic pseudo-random for the fuzz suites
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe('grid layout — gridCollides', () => {
  it('detects overlap and separation (pure rects, no identity)', () => {
    expect(gridCollides(it_('a', 0, 0), it_('b', 1, 1))).toBe(true);
    expect(gridCollides(it_('a', 0, 0), it_('b', 2, 0))).toBe(false);
    expect(gridCollides(it_('a', 0, 0), it_('b', 0, 2))).toBe(false);
    expect(gridCollides(it_('a', 0, 0, 1, 1), it_('b', 0, 0, 4, 4))).toBe(true);
  });
});

describe('grid layout — compactGrid', () => {
  it('pulls a floating item up to the top', () => {
    expect(compactGrid([it_('a', 0, 5)], key)[0].y).toBe(0);
  });

  it('stacks items without gaps', () => {
    const out = compactGrid([it_('a', 0, 0), it_('b', 0, 5)], key);
    expect(byId(out, 'b')?.y).toBe(2);
  });

  it('keeps the fixed (dragged) item at its row', () => {
    const out = compactGrid([it_('a', 0, 3), it_('b', 0, 6)], key, 'a');
    expect(byId(out, 'a')?.y).toBe(3);
    // gravity stacks b against the fixed item — it does not tunnel past it
    expect(byId(out, 'b')?.y).toBe(5);
  });

  it('compacts columns independently (an item slides up beside a tall neighbour)', () => {
    const out = compactGrid([it_('tall', 0, 0, 2, 6), it_('b', 2, 4)], key);
    expect(byId(out, 'b')?.y).toBe(0);
  });

  it('preserves input order, untouched identity, and returns the same array when settled', () => {
    const a = it_('a', 0, 0);
    const b = it_('b', 2, 5); // floats → moves
    const input = [b, a]; // note: NOT in y-order
    const out = compactGrid(input, key);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']); // order preserved
    expect(out[1]).toBe(a); // untouched item keeps its reference
    expect(out[0]).not.toBe(b);
    expect(out[0].y).toBe(0);

    const settled = compactGrid(out, key);
    expect(settled).toBe(out); // nothing to do → same array reference
  });
});

describe('grid layout — moveGridItem', () => {
  it('pushes colliding items down to make room', () => {
    const items = [it_('a', 0, 0), it_('b', 0, 2)];
    const out = moveGridItem(items, key, 'a', 0, 2, 4); // drop a onto b
    expect(byId(out, 'a')).toMatchObject({ x: 0, y: 2 });
    expect(byId(out, 'b')?.y).toBe(4);
  });

  it('clamps within the column count', () => {
    const out = moveGridItem([it_('a', 0, 0)], key, 'a', 99, 0, 4);
    expect(out[0].x).toBe(2); // cols 4 - w 2
  });

  it('cascades pushes through a stack', () => {
    const items = [it_('a', 0, 0), it_('b', 0, 2), it_('c', 0, 4)];
    const out = moveGridItem(items, key, 'a', 0, 2, 4);
    expect(byId(out, 'a')?.y).toBe(2);
    expect(byId(out, 'b')?.y).toBe(4);
    expect(byId(out, 'c')?.y).toBe(6);
  });

  it('is a same-reference no-op for an unknown key or a same-cell move', () => {
    const items = [it_('a', 0, 0)];
    expect(moveGridItem(items, key, 'zzz', 1, 1, 4)).toBe(items);
    expect(moveGridItem(items, key, 'a', 0, 0, 4)).toBe(items);
  });

  it('leaves unaffected items reference-identical (minimal reflow)', () => {
    const far = it_('far', 6, 0); // other side of the grid, never touched
    const items = [it_('a', 0, 0), it_('b', 0, 2), far];
    const out = moveGridItem(items, key, 'a', 0, 2, 8);
    expect(byId(out, 'far')).toBe(far);
  });

  it('never leaves an overlap and always honours the requested cell (fuzz)', () => {
    const rand = rng(42);
    let items: Item[] = [
      it_('a', 0, 0),
      it_('b', 2, 0),
      it_('c', 0, 2, 4, 2),
      it_('d', 4, 0, 2, 4),
      it_('e', 0, 4, 1, 1),
      it_('f', 1, 4, 3, 1),
    ];
    const COLS = 6;
    const cannotRise = (set: readonly Item[], except?: string) => {
      for (const it of set) {
        if (it.y === 0 || it.id === except) continue;
        const risen = { ...it, y: it.y - 1 };
        const collides = set.some(
          (o) => o.id !== it.id && gridCollides(risen, o),
        );
        expect(collides).toBe(true);
      }
    };
    for (let step = 0; step < 200; step++) {
      const pick = items[Math.floor(rand() * items.length)];
      const x = Math.floor(rand() * COLS);
      const y = Math.floor(rand() * 8);
      // preview: the moved item is HELD at the requested cell (mid-drag view)
      const preview = moveGridItem(items, key, pick.id, x, y, COLS) as Item[];
      const moved = byId(preview, pick.id);
      expect(moved?.x).toBe(Math.max(0, Math.min(x, COLS - pick.w)));
      expect(moved?.y).toBe(Math.max(0, y));
      expect(overlapFree(preview)).toBe(true);
      cannotRise(preview, pick.id); // everyone else is fully compacted
      // commit: the hold releases and the moved item compacts too
      items = compactGrid(preview, key) as Item[];
      expect(overlapFree(items)).toBe(true);
      cannotRise(items);
    }
  });
});

describe('grid layout — resizeGridItem', () => {
  it('pushes neighbours down when growing', () => {
    const items = [it_('a', 0, 0), it_('b', 0, 2)];
    const out = resizeGridItem(items, key, 'a', 2, 4, 4);
    expect(byId(out, 'a')).toMatchObject({ w: 2, h: 4 });
    expect(byId(out, 'b')?.y).toBe(4);
  });

  it('compacts neighbours up when shrinking', () => {
    const items = [it_('a', 0, 0, 2, 4), it_('b', 0, 4)];
    const out = resizeGridItem(items, key, 'a', 2, 2, 4);
    expect(byId(out, 'b')?.y).toBe(2);
  });

  it('clamps spans to ≥ 1 and inside the column count', () => {
    const items = [it_('a', 2, 0)];
    expect(resizeGridItem(items, key, 'a', 99, 1, 4)[0].w).toBe(2); // cols 4 - x 2
    expect(resizeGridItem(items, key, 'a', 0, 0, 4)[0]).toMatchObject({
      w: 1,
      h: 1,
    });
  });

  it('is a same-reference no-op for unchanged spans', () => {
    const items = [it_('a', 0, 0)];
    expect(resizeGridItem(items, key, 'a', 2, 2, 4)).toBe(items);
  });
});

describe('grid layout — canPlaceAt & validTargets (no-reflow validity)', () => {
  // a 4×4 board: a(0,0 2×2), b(2,2 2×2) — checkerboard corners free
  const items = [it_('a', 0, 0), it_('b', 2, 2)];

  it('accepts free rects, rejects occupied and out-of-bounds ones', () => {
    expect(canPlaceAt(items, key, 'a', 2, 0, 2, 2, 4)).toBe(true); // free corner
    expect(canPlaceAt(items, key, 'a', 1, 1, 2, 2, 4)).toBe(false); // overlaps b
    expect(canPlaceAt(items, key, 'a', 3, 0, 2, 2, 4)).toBe(false); // right edge out
    expect(canPlaceAt(items, key, 'a', -1, 0, 2, 2, 4)).toBe(false);
  });

  it('ignores the moving item itself (its current cells count as free)', () => {
    expect(canPlaceAt(items, key, 'a', 0, 0, 2, 2, 4)).toBe(true);
    expect(canPlaceAt(items, key, 'a', 1, 0, 2, 2, 4)).toBe(true); // partial self-overlap
  });

  it('masks exactly the placeable origins', () => {
    const mask = validTargets(items, key, 'a', 4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(mask[y * 4 + x]).toBe(
          canPlaceAt(items, key, 'a', x, y, 2, 2, 4) ? 1 : 0,
        );
      }
    }
    expect(mask[0 * 4 + 2]).toBe(1); // the free corner
    expect(mask[1 * 4 + 1]).toBe(0); // overlaps b
  });

  it('returns an all-zero mask for an unknown key', () => {
    expect([...validTargets(items, key, 'zzz', 4, 4)]).toEqual(
      new Array(16).fill(0),
    );
  });
});

describe('grid layout — gridRows', () => {
  it('reports the max bottom edge, 0 when empty', () => {
    expect(gridRows([])).toBe(0);
    expect(gridRows([it_('a', 0, 0), it_('b', 2, 3, 2, 4)])).toBe(7);
  });
});
