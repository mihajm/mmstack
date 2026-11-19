import { expect, test } from '@playwright/test';
import { drag } from './support/pointer';

test.describe('ngx-vflow × store — the diagram-shell seam', () => {
  test('renders the doc, a node drag commits one batch, undo restores', async ({
    page,
  }) => {
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
    await drag(
      page,
      from,
      { x: from.x + 120, y: from.y + 80 },
      {
        settle: 120,
      },
    );
    await expect(page.getByTestId('batch-count')).toContainText('1 batches');

    await page.getByTestId('undo').click();
    await expect
      .poll(async () => (await node.boundingBox())?.x ?? -1)
      .toBeCloseTo(box.x, 0);
  });
});
