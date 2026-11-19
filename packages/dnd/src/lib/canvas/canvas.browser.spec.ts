import { page, userEvent } from 'vitest/browser';

import {
  center,
  down,
  drag,
  mount,
  moveTo,
  perfCounters,
  resetPointer,
  until,
  up,
  notChromium,
} from '../testing/browser';
import { CanvasContainersExample } from '../testing/fixtures/canvas-containers';
import {
  CanvasControllerExample,
  canvasSeed,
} from '../testing/fixtures/canvas-controller';

let root: HTMLElement;
const q = (sel: string) => root.querySelector(sel) as HTMLElement;
const widget = (id: string) => q(`[data-widget="${id}"]`);
const rect = (el: Element) => el.getBoundingClientRect();
const selected = () => q('[data-testid="selected"]').innerText.trim();

async function setup(n = 0) {
  canvasSeed.n = n;
  root = (await mount(CanvasControllerExample)).nativeElement as HTMLElement;
  await until(() =>
    expect(root.querySelector('[data-mm-canvas-ready]')).not.toBeNull(),
  );
}

afterEach(async () => {
  canvasSeed.n = 0;
  await resetPointer();
});

describe('canvas: free-form controller', () => {
  beforeEach(() => setup());

  it('a move commits on release, snapped to the 8px grid', async () => {
    const before = rect(widget('w1'));
    const c = center(widget('w1'));
    await drag(widget('w1'), [{ x: c.x + 90, y: c.y + 55 }]);
    const after = rect(widget('w1'));
    expect(after.left).toBeGreaterThan(before.left + 60);
    expect(
      Math.round(after.left - rect(q('[data-canvas="main"]')).left) % 8,
    ).toBe(0);
  });

  it('snaplines appear when edges align mid-drag', async () => {
    const target = rect(widget('w2'));
    const source = rect(widget('w1'));
    // the grabbed point is the box center, so aim center = targetTop + h/2
    await drag(
      widget('w1'),
      {
        x: source.left + source.width / 2 + 24,
        y: target.top + source.height / 2 + 2,
      },
      { release: false, settle: 60 },
    );
    await until(() =>
      expect(
        root.querySelectorAll('svg.overlay line.guide').length,
      ).toBeGreaterThan(0),
    );
    await up();
  });

  it('marquee selects intersecting widgets; empty click clears', async () => {
    const s = rect(q('[data-canvas="main"]'));
    await drag(
      { x: s.left + 10, y: s.top + 10 },
      { x: s.left + 420, y: s.top + 200 },
      { settle: 60 },
    );
    await until(() => {
      expect(selected()).toContain('w1');
      expect(selected()).toContain('w2');
    });
    await moveTo({ x: s.left + 480, y: s.top + 430 });
    await down();
    await up();
    await until(() => expect(selected()).toBe('none'));
  });

  it('a selected group moves together', async () => {
    const s = rect(q('[data-canvas="main"]'));
    await drag(
      { x: s.left + 10, y: s.top + 10 },
      { x: s.left + 420, y: s.top + 200 },
    );
    const w2Before = rect(widget('w2'));
    const w1 = center(widget('w1'));
    await drag(w1, { x: w1.x + 40, y: w1.y + 40 }, { settle: 60 });
    expect(rect(widget('w2')).left).toBeGreaterThan(w2Before.left + 20);
  });

  it('click-select shows chrome; corner handle resizes', async () => {
    await userEvent.click(page.elementLocator(widget('w2')));
    await until(() => expect(selected()).toBe('w2'));
    await until(() => expect(root.querySelector('.handle.se')).not.toBeNull());
    const before = rect(widget('w2'));
    const start = center(q('.handle.se'));
    await drag(start, { x: start.x + 48, y: start.y + 24 }, { settle: 60 });
    expect(rect(widget('w2')).width).toBeGreaterThan(before.width + 30);
  });

  it('rotate handle spins the widget', async () => {
    await userEvent.click(page.elementLocator(widget('w3')));
    await until(() => expect(root.querySelector('.rotate')).not.toBeNull());
    const box = rect(widget('w3'));
    await drag(
      center(q('.rotate')),
      { x: box.right + 40, y: box.top + box.height / 2 },
      { settle: 60 },
    );
    await until(() => expect(widget('w3').style.transform).toContain('rotate'));
  });

  it('keyboard nudges by the grid step', async () => {
    await userEvent.click(page.elementLocator(widget('w4')));
    const before = rect(widget('w4'));
    widget('w4').focus();
    await userEvent.keyboard('{ArrowRight}');
    await until(() =>
      expect(
        Math.abs(rect(widget('w4')).left - (before.left + 8)),
      ).toBeLessThan(0.5),
    );
  });

  it('wheel-zoom keeps gestures accurate (zoom, then drag lands correctly)', async () => {
    await userEvent.wheel(page.elementLocator(widget('w1')), {
      delta: { y: -300 },
    });
    await until(() => expect(q('.space').style.transform).toContain('scale'));
    const before = rect(widget('w1'));
    const from = {
      x: before.left + before.width / 2,
      y: before.top + before.height / 2,
    };
    await drag(from, { x: from.x + 80, y: from.y }, { settle: 60 });
    // the widget tracked the cursor in screen space (about 80px) despite the zoom
    expect(Math.abs(rect(widget('w1')).left - before.left - 80)).toBeLessThan(
      16,
    );
  });
});

describe('canvas: containment (stages)', () => {
  const parents = () => q('[data-testid="parents"]').textContent ?? '';

  beforeEach(async () => {
    root = (await mount(CanvasContainersExample)).nativeElement as HTMLElement;
    await until(() =>
      expect(root.querySelector('[data-mm-canvas-ready]')).not.toBeNull(),
    );
  });

  it('dragging a task into another stage reparents with a rebased frame', async () => {
    expect(parents()).toContain('t1→intake');
    const review = rect(q('[data-stage="review"]'));
    await drag(
      q('[data-task="t1"]'),
      { x: review.left + 160, y: review.top + 120 },
      {
        settle: 80,
      },
    );
    await until(() => expect(parents()).toContain('t1→review'));
    const t1 = rect(q('[data-task="t1"]'));
    expect(t1.left).toBeGreaterThan(review.left);
    expect(t1.right).toBeLessThan(review.right + 1);
  });

  it('dropping a task on empty canvas moves it to the root', async () => {
    const s = rect(q('[data-canvas="stages"]'));
    await drag(
      q('[data-task="t2"]'),
      { x: s.left + 390, y: s.top + 395 },
      { settle: 80 },
    );
    await until(() => expect(parents()).toContain('t2→root'));
  });
});

describe.skipIf(notChromium)('canvas: perf guard (Chromium, CDP)', () => {
  it('a move over 200 widgets is transform-only and independent of N', async () => {
    await setup(200);
    const read = await perfCounters();
    const start = center(widget('w1'));
    await moveTo(start);
    await down();
    await moveTo({ x: start.x + 6, y: start.y + 6 });
    // Ctrl bypasses snapping: the guard measures the pure move path
    await userEvent.keyboard('{Control>}');
    const before = await read();
    for (let i = 0; i < 60; i++)
      await moveTo({
        x: start.x + 6 + (i % 24) * 5,
        y: start.y + 6 + (i % 16) * 5,
      });
    const after = await read();
    await up();
    await userEvent.keyboard('{/Control}');
    expect(after.layout - before.layout).toBeLessThan(10);
  });
});
