import {
  byText,
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
import { PointerEngineExample } from '../testing/fixtures/pointer-engine';

// Edge detection reads the target's rect per move, so its cost must be linear
// (one read per move) and absent when a target does not opt into `edges`.
// Chrome's real LayoutCount via CDP; Chromium only.

let root: HTMLElement;
const zone = (id: string) =>
  root.querySelector(`[data-zone="${id}"]`) as HTMLElement;
const MOVES = 60;

beforeEach(async () => {
  root = (await mount(PointerEngineExample)).nativeElement as HTMLElement;
});
afterEach(resetPointer);

describe.skipIf(notChromium)('pointer engine edge detection cost', () => {
  it('the layout counter sees forced layouts in the test frame (control)', async () => {
    const read = await perfCounters();
    const before = await read();
    forceLayouts(20);
    const after = await read();
    expect(after.layout - before.layout).toBeGreaterThanOrEqual(20);
  });

  it('edge detection stays bounded: one rect read per move, never a multiplier', async () => {
    const read = await perfCounters();
    const r = zone('edge').getBoundingClientRect();
    const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    await moveTo(center(byText(zone('a'), '.chip', 'One')));
    await down();
    await moveTo(mid, 6);

    const before = await read();
    for (let i = 0; i < MOVES; i++)
      await moveTo({ x: mid.x, y: r.top + 20 + (i % 20) * 8 });
    const after = await read();
    await up();

    expect(after.layout - before.layout).toBeLessThan(MOVES + 15);
  });

  it('a drag with no edge target stays transform-only: edge code is zero-cost when off', async () => {
    const read = await perfCounters();
    const target = center(zone('b'));
    await moveTo(center(byText(zone('a'), '.chip', 'One')));
    await down();
    await moveTo(target, 6);

    const before = await read();
    for (let i = 0; i < MOVES; i++)
      await moveTo({ x: target.x, y: target.y + (i % 24) * 3 });
    const after = await read();
    await up();

    expect(after.layout - before.layout).toBeLessThan(10);
  });
});
