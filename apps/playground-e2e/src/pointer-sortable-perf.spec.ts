import { expect, test, type Page } from '@playwright/test';
import { resolvePoint } from './support/pointer';

/**
 * Performance guard: a pointer drag must be **transform-only** between drag-start
 * and commit — the browser composites, it must NOT lay out per move. We read
 * Chrome's real `LayoutCount` via CDP across a long stream of moves; if layout
 * scaled with move count we'd have a forced-reflow (read-after-write) bug.
 */
const rows = (page: Page) => page.locator('ul[data-list="pointer"] li');

type Cdp = Awaited<ReturnType<Page['context']>['newCDPSession']> extends never
  ? never
  : Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

async function counts(client: Cdp) {
  const { metrics } = (await client.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { layout: get('LayoutCount'), recalc: get('RecalcStyleCount') };
}

test('a drag is transform-only — no per-move layout thrash', async ({ page }) => {
  await page.goto('/sortable-pointer');
  await expect(page.getByText('Auth flow')).toBeVisible();

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  const start = await resolvePoint(rows(page).first());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10); // activate + drag-start measure happens here

  const before = await counts(client);
  const MOVES = 60;
  for (let i = 0; i < MOVES; i++) {
    // oscillate within the list, crossing boundaries repeatedly
    await page.mouse.move(start.x, start.y + 10 + (i % 24) * 7);
  }
  const after = await counts(client);
  await page.mouse.up();

  const layoutDelta = after.layout - before.layout;
  const recalcDelta = after.recalc - before.recalc;
  console.log(`[perf] ${MOVES} moves → layoutΔ=${layoutDelta} recalcΔ=${recalcDelta}`);

  // layout must not scale with move count (transforms don't lay out)
  expect(layoutDelta).toBeLessThan(10);
});
