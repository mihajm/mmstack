import { expect, test, type Page } from '@playwright/test';
import { resolvePoint } from './support/pointer';

/**
 * Performance guard for pointer-engine closest-edge detection. Edge detection
 * reads the target's `getBoundingClientRect` per move, so the cost must be
 * strictly linear (one read per move) and must not exist at all when a target
 * does not opt into `edges`. We read Chrome's real `LayoutCount` via CDP; a
 * per-move multiplier or a non-zero cost on the no-edge path is a regression.
 */
type Cdp = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

async function layoutCount(client: Cdp): Promise<number> {
  const { metrics } = (await client.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/pointer-engine');
  await expect(page.getByText('Three')).toBeVisible();
});

test('edge detection stays bounded — one rect read per move, never a multiplier', async ({
  page,
}) => {
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  const one = page.locator('[data-zone="a"] .chip', { hasText: 'One' });
  const zone = page.locator('[data-zone="edge"]');
  const box = (await zone.boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const start = await resolvePoint(one);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y, { steps: 6 }); // activate + enter the edge zone

  const before = await layoutCount(client);
  const MOVES = 60;
  for (let i = 0; i < MOVES; i++) {
    // oscillate across the top/bottom midline, flipping the edge every few moves
    await page.mouse.move(mid.x, box.y + 20 + (i % 20) * 8);
  }
  const after = await layoutCount(client);
  await page.mouse.up();

  const delta = after - before;
  console.log(`[perf] edge zone ${MOVES} moves → layoutΔ=${delta}`);
  // linear: at most ~one forced layout per move, never a per-target multiplier
  expect(delta).toBeLessThan(MOVES + 15);
});

test('a drag with no edge target stays transform-only — edge code is zero-cost when off', async ({
  page,
}) => {
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  const one = page.locator('[data-zone="a"] .chip', { hasText: 'One' });
  const bucketB = page.locator('[data-zone="b"]');
  const box = (await bucketB.boundingBox())!;
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const start = await resolvePoint(one);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });

  const before = await layoutCount(client);
  const MOVES = 60;
  for (let i = 0; i < MOVES; i++) {
    await page.mouse.move(target.x, target.y + (i % 24) * 3);
  }
  const after = await layoutCount(client);
  await page.mouse.up();

  const delta = after - before;
  console.log(`[perf] non-edge zone ${MOVES} moves → layoutΔ=${delta}`);
  // no edges requested → attachEdge returns early, no getBoundingClientRect
  expect(delta).toBeLessThan(10);
});
