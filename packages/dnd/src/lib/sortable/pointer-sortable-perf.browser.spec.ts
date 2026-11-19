import {
  center,
  down,
  forceLayouts,
  mount,
  moveTo,
  perfCounters,
  resetPointer,
  up,
  notChromium,
} from '../testing/browser';
import { PointerSortableExample } from '../testing/fixtures/pointer-sortable';

// A pointer drag must be transform-only between drag start and commit: the
// browser composites, it must not lay out per move. Chrome's real LayoutCount
// via CDP; Chromium only.

afterEach(resetPointer);

describe.skipIf(notChromium)('pointer sortable drag cost', () => {
  it('the layout counter sees forced layouts in the test frame (control)', async () => {
    const read = await perfCounters();
    const before = await read();
    forceLayouts(20);
    expect((await read()).layout - before.layout).toBeGreaterThanOrEqual(20);
  });

  it('a drag is transform-only: no per-move layout thrash', async () => {
    const root = (await mount(PointerSortableExample))
      .nativeElement as HTMLElement;
    const read = await perfCounters();
    const start = center(
      root.querySelector('ul[data-list="pointer"] li') as HTMLElement,
    );
    await moveTo(start);
    await down();
    await moveTo({ x: start.x, y: start.y + 10 });

    const before = await read();
    const MOVES = 60;
    for (let i = 0; i < MOVES; i++)
      await moveTo({ x: start.x, y: start.y + 10 + (i % 24) * 7 });
    const after = await read();
    await up();

    expect(after.layout - before.layout).toBeLessThan(10);
  });
});
