import { expect, test, type Page } from '@playwright/test';
import { drag } from './support/pointer';

const chipsIn = (page: Page, zone: string) => () =>
  page
    .locator(`[data-zone="${zone}"] .chip`)
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

test.beforeEach(async ({ page }) => {
  await page.goto('/pointer-engine');
  await expect(page.getByText('Three')).toBeVisible();
});

test('drags a chip from bucket A into bucket B (pointer engine, real elementsFromPoint)', async ({
  page,
}) => {
  const one = page.locator('[data-zone="a"] .chip', { hasText: 'One' });
  const bucketB = page.locator('[data-zone="b"]');
  const box = (await bucketB.boundingBox())!;
  await drag(page, one, { x: box.x + box.width / 2, y: box.y + box.height - 12 }, {
    steps: 20,
    settle: 60,
  });

  await expect.poll(chipsIn(page, 'b')).toContain('One');
  await expect.poll(chipsIn(page, 'a')).not.toContain('One');
});

test('highlights the hovered drop zone while dragging', async ({ page }) => {
  const three = page.locator('[data-zone="b"] .chip', { hasText: 'Three' });
  const bucketA = page.locator('[data-zone="a"]');
  const box = (await bucketA.boundingBox())!;
  await drag(page, three, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, {
    steps: 16,
    settle: 40,
    onWaypoint: async (i) => {
      // mid-drag (not the final settle), the hovered zone should carry .over
      if (i === 1) await expect(bucketA).toHaveClass(/over/);
    },
  });
  await expect.poll(chipsIn(page, 'a')).toContain('Three');
});
