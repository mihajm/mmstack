import { expect, test, type Page } from '@playwright/test';
import { drag } from './support/pointer';

// labels of the direct children rendered under the list for tree node `id`
const childrenOf = (page: Page, node: string) => () =>
  page
    .locator(`ul[data-node="${node}"] > li > app-tree-node > .tn-label`)
    .evaluateAll((els) =>
      els.map((e) => (e.textContent ?? '').replace('⠿', '').trim()),
    );

test.beforeEach(async ({ page }) => {
  await page.goto('/sortable-tree');
  await expect(page.getByText('mmstack')).toBeVisible();
});

const grip = (page: Page, label: string) =>
  page.locator('.tn-label', { hasText: label }).first();

test('renders the recursive tree', async ({ page }) => {
  await expect(page.getByText('dnd')).toBeVisible();
  await expect(page.getByText('primitives')).toBeVisible();
});

test('moves a leaf DOWN into a deeper node', async ({ page }) => {
  // Photos (root level) -> into mmstack (node 21)
  const photos = grip(page, 'Photos');
  const target = (await page.locator('ul[data-node="21"]').boundingBox())!;
  await drag(page, photos, { x: target.x + target.width / 2, y: target.y + target.height / 2 }, {
    steps: 24,
    settle: 80,
  });
  await expect.poll(childrenOf(page, '21')).toContain('Photos');
});

test('moves a deep node UP to the root', async ({ page }) => {
  const dnd = grip(page, 'dnd');
  // drop onto the "Documents" label — that point is in the root list (above
  // Documents' own child-zone), so the node lands at the root level.
  const docs = (await grip(page, 'Documents').boundingBox())!;
  await drag(page, dnd, { x: docs.x + docs.width / 2, y: docs.y + docs.height / 2 }, {
    steps: 24,
    settle: 80,
  });
  await expect.poll(childrenOf(page, 'root')).toContain('dnd');
});

test('CYCLE GUARD: a node cannot be dropped into its own subtree', async ({ page }) => {
  // drag "Projects" (node 2) onto its descendant "mmstack" (node 21) list
  const projects = grip(page, 'Projects');
  const target = (await page.locator('ul[data-node="21"]').boundingBox())!;
  await drag(page, projects, { x: target.x + target.width / 2, y: target.y + target.height / 2 }, {
    steps: 24,
    settle: 80,
  });
  // mmstack must NOT contain Projects (would be a cycle)
  await expect.poll(childrenOf(page, '21')).not.toContain('Projects');
  // and Projects' own children are intact
  await expect.poll(childrenOf(page, '2')).toEqual(['mmstack', 'playground']);
});
