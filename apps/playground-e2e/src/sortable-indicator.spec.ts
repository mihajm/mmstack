import { expect, test, type Page } from '@playwright/test';

// Native (indicator) sortable engine, exercised with real HTML5 DnD. Items are
// drop targets, so moving between them fires `onDropTargetChange` → the session
// pointer advances even under Playwright's synthetic `dragTo` (same-list too).

const listOrder = (page: Page, name: string) => () =>
  page
    .locator(`ul[data-list="${name}"] li`)
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

test.beforeEach(async ({ page }) => {
  await page.goto('/sortable-indicator');
  await expect(
    page.locator('ul[data-list="ind"] li', { hasText: 'One' }),
  ).toBeVisible();
});

test('reorders within a list (same-list, via per-item drop targets)', async ({
  page,
}) => {
  const list = page.locator('ul[data-list="ind"]');
  const one = list.locator('li', { hasText: 'One' });
  const four = list.locator('li', { hasText: 'Four' });
  await one.dragTo(four, { targetPosition: { x: 12, y: 24 } }); // near Four's bottom

  const after = await listOrder(page, 'ind')();
  expect(after[0]).not.toBe('One'); // One left the front
  expect([...after].sort()).toEqual(['Four', 'One', 'Three', 'Two']); // set conserved
});

test('moves a row across lists (shared group)', async ({ page }) => {
  const todo = page.locator('ul[data-list="ind-todo"]');
  const doing = page.locator('ul[data-list="ind-doing"]');
  await todo.getByText('Build').dragTo(doing, { targetPosition: { x: 12, y: 12 } });

  await expect(doing.getByText('Build')).toBeVisible();
  await expect(todo.getByText('Build')).toHaveCount(0);
});

test('inserts a mapped item from the palette', async ({ page }) => {
  const list = page.locator('ul[data-list="ind-insert"]');
  const chip = page.locator('.chip', { hasText: 'note' });
  await chip.dragTo(list, { targetPosition: { x: 12, y: 12 } });

  await expect(list.getByText('New note')).toBeVisible();
  // palette chip stays (it's a source, not consumed)
  await expect(page.locator('.chip', { hasText: 'note' })).toHaveCount(1);
});
