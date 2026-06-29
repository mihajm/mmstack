import { expect, test } from '@playwright/test';

test.describe('features — drag handle, conditional drop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/features');
    await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible();
  });

  test('drag handle: the grip drags, the body does not', async ({ page }) => {
    const grip = page.locator('.grip');
    const body = page.locator('.box .body');
    const target = page.locator('section', { hasText: 'Drag handle' }).locator('.zone');

    // dragging by the body should NOT start a drag (handle-only)
    await body.dragTo(target);
    await expect(target).toHaveText(/handle target/);

    // dragging by the grip works
    await grip.dragTo(target);
    await expect(target).toHaveText(/dropped/);
  });

  test('canDrop: accepts the allowed chip, rejects the blocked one', async ({ page }) => {
    const zone = page.locator('section', { hasText: 'Conditional drop' }).locator('.zone');

    await page.locator('.chip.no').dragTo(zone);
    await expect(zone).toHaveText(/accepted: —/);

    await page.locator('.chip.ok').dragTo(zone);
    await expect(zone).toHaveText(/accepted: allowed/);
  });
});
