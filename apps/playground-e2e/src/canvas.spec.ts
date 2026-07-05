import { expect, test, type Page } from '@playwright/test';
import { drag, filmstrip, resolvePoint } from './support/pointer';

const widget = (page: Page, id: string) =>
  page.locator(`[data-widget="${id}"]`);

test.describe('canvas — free-form controller', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/canvas-controller');
    await expect(widget(page, 'w1')).toBeVisible();
    await expect(page.locator('[data-mm-canvas-ready]')).toBeAttached();
  });

  test('a move commits on release, snapped to the 8px grid', async ({ page }) => {
    const before = await widget(page, 'w1').boundingBox();
    if (!before) throw new Error('no box');
    const center = await resolvePoint(widget(page, 'w1'));

    await filmstrip(page, 'canvas-move', widget(page, 'w1'), [
      { x: center.x + 90, y: center.y + 55 },
    ]);

    const after = await widget(page, 'w1').boundingBox();
    if (!after) throw new Error('no box');
    expect(after.x).toBeGreaterThan(before.x + 60);
    // grid-snapped: offsets stay multiples of 8 relative to the surface
    const surface = await page.locator('[data-canvas="main"]').boundingBox();
    if (!surface) throw new Error('no surface');
    expect(Math.round(after.x - surface.x) % 8).toBe(0);
  });

  test('snaplines appear when edges align mid-drag', async ({ page }) => {
    const target = await widget(page, 'w2').boundingBox();
    const source = await widget(page, 'w1').boundingBox();
    if (!target || !source) throw new Error('no boxes');

    // drag w1 so its TOP edge lands on w2's top edge (within snap range):
    // the grabbed point sits at the box center, so aim center = targetTop + h/2
    await drag(
      page,
      widget(page, 'w1'),
      { x: source.x + source.width / 2 + 24, y: target.y + source.height / 2 + 2 },
      { release: false, settle: 60 },
    );
    await expect
      .poll(() => page.locator('svg.overlay line.guide').count())
      .toBeGreaterThan(0);
    await page.mouse.up();
  });

  test('marquee selects intersecting widgets; empty click clears', async ({ page }) => {
    const surface = await page.locator('[data-canvas="main"]').boundingBox();
    if (!surface) throw new Error('no surface');

    await drag(
      page,
      { x: surface.x + 10, y: surface.y + 10 },
      { x: surface.x + 420, y: surface.y + 200 },
      { settle: 60 },
    );
    await expect
      .poll(() => page.getByTestId('selected').innerText())
      .toContain('w1');
    await expect
      .poll(() => page.getByTestId('selected').innerText())
      .toContain('w2');

    await page.mouse.click(surface.x + 480, surface.y + 430);
    await expect(page.getByTestId('selected')).toHaveText('none');
  });

  test('a selected group moves together', async ({ page }) => {
    const surface = await page.locator('[data-canvas="main"]').boundingBox();
    if (!surface) throw new Error('no surface');
    await drag(
      page,
      { x: surface.x + 10, y: surface.y + 10 },
      { x: surface.x + 420, y: surface.y + 200 },
    );
    const w2Before = await widget(page, 'w2').boundingBox();
    if (!w2Before) throw new Error('no box');

    const w1 = await resolvePoint(widget(page, 'w1'));
    await drag(page, w1, { x: w1.x + 40, y: w1.y + 40 }, { settle: 60 });

    const w2After = await widget(page, 'w2').boundingBox();
    if (!w2After) throw new Error('no box');
    expect(w2After.x).toBeGreaterThan(w2Before.x + 20);
  });

  test('click-select shows chrome; corner handle resizes', async ({ page }) => {
    await widget(page, 'w2').click();
    await expect(page.getByTestId('selected')).toHaveText('w2');
    const grip = page.locator('.handle.se');
    await expect(grip).toBeVisible();

    const before = await widget(page, 'w2').boundingBox();
    const start = await resolvePoint(grip);
    await drag(page, start, { x: start.x + 48, y: start.y + 24 }, { settle: 60 });
    const after = await widget(page, 'w2').boundingBox();
    if (!before || !after) throw new Error('no boxes');
    expect(after.width).toBeGreaterThan(before.width + 30);
  });

  test('rotate handle spins the widget', async ({ page }) => {
    await widget(page, 'w3').click();
    const rotate = page.locator('.rotate');
    await expect(rotate).toBeVisible();
    const box = await widget(page, 'w3').boundingBox();
    const start = await resolvePoint(rotate);
    if (!box) throw new Error('no box');

    await drag(page, start, { x: box.x + box.width + 40, y: box.y + box.height / 2 }, { settle: 60 });
    await expect
      .poll(() => widget(page, 'w3').evaluate((el) => el.style.transform))
      .toContain('rotate');
  });

  test('keyboard nudges by the grid step', async ({ page }) => {
    await widget(page, 'w4').click();
    const before = await widget(page, 'w4').boundingBox();
    if (!before) throw new Error('no box');
    await widget(page, 'w4').press('ArrowRight');
    await expect
      .poll(async () => (await widget(page, 'w4').boundingBox())?.x ?? 0)
      .toBeCloseTo(before.x + 8, 0);
  });

  test('wheel-zoom keeps gestures accurate (zoom, then drag lands correctly)', async ({ page }) => {
    const surface = await page.locator('[data-canvas="main"]').boundingBox();
    if (!surface) throw new Error('no surface');

    // zoom in around w1's center so it stays under the cursor (and in view)
    const anchor = await widget(page, 'w1').boundingBox();
    if (!anchor) throw new Error('no box');
    await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() => page.locator('.space').evaluate((el) => el.style.transform))
      .toContain('scale');

    const before = await widget(page, 'w1').boundingBox();
    if (!before) throw new Error('no box');
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await drag(page, from, { x: from.x + 80, y: from.y }, { settle: 60 });

    const after = await widget(page, 'w1').boundingBox();
    if (!after) throw new Error('no box');
    // the widget tracked the cursor in SCREEN space (≈80px) despite the zoom
    expect(Math.abs(after.x - before.x - 80)).toBeLessThan(16);
  });
});

test.describe('canvas — containment (stages)', () => {
  test('dragging a task into another stage reparents with a rebased frame', async ({ page }) => {
    await page.goto('/canvas-containers');
    const task = page.locator('[data-task="t1"]');
    await expect(task).toBeVisible();
    await expect(page.locator('[data-mm-canvas-ready]')).toBeAttached();
    await expect(page.getByTestId('parents')).toContainText('t1→intake');

    const review = await page.locator('[data-stage="review"]').boundingBox();
    if (!review) throw new Error('no stage box');
    await drag(page, task, { x: review.x + 160, y: review.y + 120 }, { settle: 80 });

    await expect(page.getByTestId('parents')).toContainText('t1→review');
    // the task now renders inside the review stage
    const t1 = await page.locator('[data-task="t1"]').boundingBox();
    if (!t1) throw new Error('no task box');
    expect(t1.x).toBeGreaterThan(review.x);
    expect(t1.x + t1.width).toBeLessThan(review.x + review.width + 1);
  });

  test('dropping a task on empty canvas moves it to the root', async ({ page }) => {
    await page.goto('/canvas-containers');
    await expect(page.locator('[data-mm-canvas-ready]')).toBeAttached();
    const task = page.locator('[data-task="t2"]');
    const surface = await page.locator('[data-canvas="stages"]').boundingBox();
    if (!surface) throw new Error('no surface');

    await drag(page, task, { x: surface.x + 390, y: surface.y + 395 }, { settle: 80 });
    await expect(page.getByTestId('parents')).toContainText('t2→root');
  });
});

test.describe('canvas — perf guard', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'CDP performance metrics are Chromium-only',
  );

  test('a move over 200 widgets is transform-only and independent of N', async ({ page }) => {
    await page.goto('/canvas-controller?n=200');
    await expect(widget(page, 'w1')).toBeVisible();
    await expect(page.locator('[data-mm-canvas-ready]')).toBeAttached();

    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const counts = async () => {
      const { metrics } = (await client.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
    };

    const start = await resolvePoint(widget(page, 'w1'));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 6, start.y + 6);

    // Ctrl bypasses snapping: the guard measures the pure move path (guides
    // are separate SVG chrome whose appearance legitimately lays out).
    await page.keyboard.down('Control');
    const before = await counts();
    const MOVES = 60;
    for (let i = 0; i < MOVES; i++) {
      await page.mouse.move(start.x + 6 + (i % 24) * 5, start.y + 6 + (i % 16) * 5);
    }
    const after = await counts();
    await page.mouse.up();
    await page.keyboard.up('Control');

    const delta = after - before;
    console.log(`[perf] canvas 200 widgets, ${MOVES} moves → layoutΔ=${delta}`);
    expect(delta).toBeLessThan(10);
  });
});
