import { expect, test, type Page } from '@playwright/test';
import { drag } from './support/pointer';

const widget = (page: Page, id: string) =>
  page.locator(`[data-widget="${id}"]`);
const batchCount = async (page: Page) =>
  Number((await page.getByTestId('batch-count').innerText()).split(' ')[0]);

test.describe('canvas × store — gesture-grained ops', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/canvas-store');
    await expect(widget(page, 'a')).toBeVisible();
    await expect(page.locator('[data-mm-canvas-ready]')).toBeAttached();
  });

  test('one drag emits exactly one op batch; undo/redo restores frames', async ({ page }) => {
    expect(await batchCount(page)).toBe(0);
    const before = await widget(page, 'a').boundingBox();
    if (!before) throw new Error('no box');
    const center = { x: before.x + before.width / 2, y: before.y + before.height / 2 };

    await drag(page, widget(page, 'a'), { x: center.x + 100, y: center.y + 60 }, { settle: 80 });
    await expect.poll(() => batchCount(page)).toBe(1);
    const moved = await widget(page, 'a').boundingBox();
    if (!moved) throw new Error('no box');
    expect(moved.x).toBeGreaterThan(before.x + 60);

    // the batch is per-property frame ops, nothing else
    await expect(page.getByTestId('trace')).toContainText('widgets.0.frame.x');
    await expect(page.getByTestId('trace')).toContainText('widgets.0.frame.y');

    await page.getByTestId('undo').click();
    await expect
      .poll(async () => (await widget(page, 'a').boundingBox())?.x ?? -1)
      .toBeCloseTo(before.x, 0);

    await page.getByTestId('redo').click();
    await expect
      .poll(async () => (await widget(page, 'a').boundingBox())?.x ?? -1)
      .toBeCloseTo(moved.x, 0);
  });

  test('two drags = two undo steps, restored in order', async ({ page }) => {
    const start = await widget(page, 'a').boundingBox();
    if (!start) throw new Error('no box');

    const c0 = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    await drag(page, widget(page, 'a'), { x: c0.x + 60, y: c0.y }, { settle: 60 });
    const mid = await widget(page, 'a').boundingBox();
    const c1 = { x: (mid?.x ?? 0) + (mid?.width ?? 0) / 2, y: (mid?.y ?? 0) + (mid?.height ?? 0) / 2 };
    await drag(page, widget(page, 'a'), { x: c1.x + 60, y: c1.y + 60 }, { settle: 60 });
    await expect.poll(() => batchCount(page)).toBe(2);

    await page.getByTestId('undo').click();
    await expect
      .poll(async () => (await widget(page, 'a').boundingBox())?.x ?? -1)
      .toBeCloseTo(mid?.x ?? -1, 0);
    await page.getByTestId('undo').click();
    await expect
      .poll(async () => (await widget(page, 'a').boundingBox())?.x ?? -1)
      .toBeCloseTo(start.x, 0);
  });
});

test.describe('ngx-vflow × store — the diagram-shell seam', () => {
  test('renders the doc, a node drag commits one batch, undo restores', async ({ page }) => {
    await page.goto('/vflow-store');
    const node = page.locator('vflow').getByText('Start');
    // client-only route (vflow is not SSR-safe): first render waits on the dev
    // server's cold dependency optimization
    await expect(node).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('batch-count')).toContainText('0 batches');
    await expect(page.getByTestId('edge-count')).toContainText('1 edges');

    const box = await node.boundingBox();
    if (!box) throw new Error('no node box');
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await drag(page, from, { x: from.x + 120, y: from.y + 80 }, {
      settle: 120,
    });
    await expect(page.getByTestId('batch-count')).toContainText('1 batches');

    await page.getByTestId('undo').click();
    await expect
      .poll(async () => (await node.boundingBox())?.x ?? -1)
      .toBeCloseTo(box.x, 0);
  });
});
