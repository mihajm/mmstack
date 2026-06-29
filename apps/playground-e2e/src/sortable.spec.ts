import { expect, test, type Page } from '@playwright/test';

const list = (page: Page, name: string) =>
  page.locator('.list-wrap').filter({ hasText: name }).locator('ul');

test.describe('sortable — reorderable (edges, cross-list, keyboard)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable');
    await expect(page.getByText('Auth flow')).toBeVisible();
  });

  test('reorders within a list using the closest edge (hitbox)', async ({ page }) => {
    const backlog = list(page, 'Backlog');
    const search = backlog.getByText('Search filters'); // last
    const auth = backlog.getByText('Auth flow'); // first

    // drop near the TOP of the first item → insert before it
    await search.dragTo(auth, { targetPosition: { x: 12, y: 2 } });

    const order = await backlog.locator('li').allInnerTexts();
    expect(order.indexOf('Search filters')).toBeLessThan(order.indexOf('Auth flow'));
  });

  test('moves an item across lists (shared group)', async ({ page }) => {
    const backlog = list(page, 'Backlog');
    const sprint = list(page, 'Sprint');

    await backlog.getByText('Billing page').dragTo(sprint, {
      targetPosition: { x: 12, y: 12 },
    });

    await expect(sprint.getByText('Billing page')).toBeVisible();
    await expect(backlog.getByText('Billing page')).toHaveCount(0);
  });

  test('inserts a foreign palette item at the drop index', async ({ page }) => {
    const backlog = list(page, 'Backlog');
    const chip = page.locator('.chip', { hasText: 'Text' });
    const first = backlog.locator('li').first(); // Auth flow

    // drop near the TOP of the first item → insert the mapped item at index 0
    await chip.dragTo(first, { targetPosition: { x: 12, y: 2 } });

    await expect(backlog.locator('li').first()).toHaveText(/New Text/);
    // palette chip is a clone source: it stays put
    await expect(page.locator('.chip', { hasText: 'Text' })).toHaveCount(1);
  });

  test('nested lists: a drop into the inner list does not double-insert into the outer', async ({ page }) => {
    const inner = page.locator('ul[data-list="inner"]');
    const outer = page.locator('ul[data-list="outer"]');
    const blockC = outer.locator(':scope > li', { hasText: 'Block C' });

    await blockC.dragTo(inner, { targetPosition: { x: 12, y: 12 } });

    // landed in the inner list, exactly once anywhere (no double-insert into outer)
    await expect(inner.getByText('Block C')).toBeVisible();
    await expect(page.getByText('Block C', { exact: true })).toHaveCount(1);
    // the outer list's OWN items no longer include Block C (its own <span> labels)
    await expect(outer.locator(':scope > li > span')).toHaveText(['Section', 'Block B']);
  });

  test('reorders with the keyboard (ArrowDown on a focused item)', async ({ page }) => {
    const backlog = list(page, 'Backlog');
    const first = backlog.locator('li').first();

    await expect(first).toHaveAttribute('tabindex', '0'); // set in afterNextRender
    await first.press('ArrowDown'); // focuses + dispatches atomically (no race)

    await expect
      .poll(() => backlog.locator('li').first().innerText())
      .toContain('Billing page'); // was 2nd, now 1st
    const order = await backlog.locator('li').allInnerTexts();
    expect(order[1]).toContain('Auth flow'); // moved down one
  });
});
