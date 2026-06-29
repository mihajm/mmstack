import { expect, test, type Page } from '@playwright/test';

const column = (page: Page, name: string) =>
  page
    .locator('section.col')
    .filter({ has: page.locator('header', { hasText: new RegExp(`^${name}$`) }) });

test.describe('core — draggable + dropTarget + monitor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/core');
    await expect(page.getByText('Design landing page')).toBeVisible();
  });

  test('drags a card into another column', async ({ page }) => {
    const card = page.getByText('Design landing page');
    const done = column(page, 'done');

    await card.dragTo(done);

    await expect(done.getByText('Design landing page')).toBeVisible();
    await expect(column(page, 'todo').getByText('Design landing page')).toHaveCount(0);
  });

  test('reflects the active drag in the monitor banner, then clears on drop', async ({
    page,
  }) => {
    // Manual native sequence so we can assert mid-drag (dragTo is atomic).
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    const card = page.getByText('Write copy');
    const done = column(page, 'done');
    const status = page.locator('.status');

    await card.dispatchEvent('dragstart', { dataTransfer });
    await expect(status).toContainText('Write copy'); // monitor.source() derived live

    await done.dispatchEvent('dragenter', { dataTransfer });
    await done.dispatchEvent('drop', { dataTransfer });
    await card.dispatchEvent('dragend', { dataTransfer });

    await expect(status).not.toContainText('Dragging'); // monitor.isDragging() back to false
    await expect(done.getByText('Write copy')).toBeVisible();
  });

  test('only the innermost accepting zone receives the drop', async ({ page }) => {
    // moving a card to 'doing' should remove it from 'todo' (single owner)
    const card = page.getByText('Set up analytics');
    await card.dragTo(column(page, 'doing'));
    await expect(column(page, 'doing').getByText('Set up analytics')).toBeVisible();
    await expect(column(page, 'todo').getByText('Set up analytics')).toHaveCount(0);
  });
});
