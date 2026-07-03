import { expect, test } from '@playwright/test';

/**
 * End-to-end proof of the split-graph in a REAL browser Web Worker: the demo route spins the
 * worker via `new Worker(new URL(...))` (bundler-emitted chunk), replicates a worker-owned store,
 * routes a write to it, reflects a worker-side derivation, and runs a heavy task off-main.
 */
test.describe('@mmstack/worker — split-graph demo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/worker');
    // the worker connects asynchronously after the hello/ready handshake
    await expect(page.locator('.status.live')).toContainText('connected', {
      timeout: 15_000,
    });
  });

  test('routes a write to the worker-owned store and reflects it in the replica', async ({
    page,
  }) => {
    const counter = page.getByTestId('counter');
    await expect(counter).toHaveText('0');

    await page.getByTestId('inc').click();
    await expect(counter).toHaveText('1'); // authoritative batch round-tripped from the worker
    await page.getByTestId('inc').click();
    await expect(counter).toHaveText('2');
  });

  test('mirrors the worker-side published derivation (rung 3)', async ({ page }) => {
    const stats = page.getByTestId('stats');
    await page.getByTestId('inc').click(); // history: [1]
    await page.getByTestId('inc').click(); // history: [2]
    await expect(stats).toContainText('count');
    await expect(stats.locator('div', { hasText: 'count' })).toContainText('2');
    await expect(stats.locator('div', { hasText: 'sum' })).toContainText('3');
  });

  test('runs a heavy task off-main and shows its result (rung 1)', async ({ page }) => {
    const fib = page.getByTestId('fib');
    // default n = 35 → fib(35) = 9227465
    await expect(fib).toHaveText('9227465', { timeout: 10_000 });
  });
});
