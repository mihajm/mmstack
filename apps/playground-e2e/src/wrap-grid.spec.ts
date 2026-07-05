import { expect, test, type Page } from '@playwright/test';
import { at, drag, filmstrip } from './support/pointer';

const tiles = (page: Page) =>
  page.locator('ul[data-list="gallery"] li');
const labels = async (page: Page) => tiles(page).allInnerTexts();

test.describe('wrap grid — 2D sortable', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/wrap-grid');
    await expect(tiles(page).first()).toBeVisible();
  });

  test('reorders across a row boundary in reading order', async ({ page }) => {
    const before = await labels(page);
    expect(before.slice(0, 6)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);

    // drag T1 onto the second row's middle tile — reading-order insert
    await filmstrip(page, 'wrap-row-cross', tiles(page).first(), [
      tiles(page).nth(4),
    ]);

    await expect.poll(() => labels(page)).toEqual([
      'T2',
      'T3',
      'T4',
      'T5',
      'T1',
      'T6',
      'T7',
      'T8',
      'T9',
    ]);
  });

  test('a drag within the same slot commits nothing', async ({ page }) => {
    const before = await labels(page);
    await drag(page, tiles(page).first(), await at(tiles(page).first(), { fx: 0.6, fy: 0.6 }));
    await expect.poll(() => labels(page)).toEqual(before);
  });

  test('keyboard: ArrowRight steps, ArrowDown jumps a row', async ({ page }) => {
    await tiles(page).first().press('ArrowRight');
    await expect.poll(() => labels(page)).toEqual([
      'T2',
      'T1',
      'T3',
      'T4',
      'T5',
      'T6',
      'T7',
      'T8',
      'T9',
    ]);

    // Down lands on the geometrically nearest tile in the row BELOW, wherever
    // the responsive wrap put the row break.
    const t1 = page.locator('ul[data-list="gallery"] li', { hasText: 'T1' });
    const before = await t1.boundingBox();
    if (!before) throw new Error('no box');
    await t1.press('ArrowDown');
    await expect
      .poll(async () => (await t1.boundingBox())?.y ?? -1)
      .toBeGreaterThan(before.y + 40); // moved a row down
    await expect
      .poll(async () => Math.abs(((await t1.boundingBox())?.x ?? 0) - before.x))
      .toBeLessThan(60); // stayed in (or next to) its column
  });

  test('moves between the tray list and the wrap grid (one group)', async ({ page }) => {
    const mini = page.locator('ul[data-list="mini"] li');
    const tray = page.locator('ul[data-list="tray"] li');
    await expect(mini).toHaveCount(5);
    await expect(tray).toHaveCount(2);

    // tray row → grid (drop near the last tile)
    await drag(page, tray.first(), mini.nth(4), { settle: 60 });
    await expect(mini).toHaveCount(6);
    await expect(tray).toHaveCount(1);

    // grid tile → tray
    await drag(page, mini.first(), tray.first(), { settle: 60 });
    await expect(mini).toHaveCount(5);
    await expect(tray).toHaveCount(2);
  });
});
