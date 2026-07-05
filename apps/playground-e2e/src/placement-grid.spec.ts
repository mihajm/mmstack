import { expect, test, type Page } from '@playwright/test';
import { at, drag, filmstrip, resolvePoint } from './support/pointer';

const widget = (page: Page, label: string) =>
  page.locator('[data-grid="dashboard"] .widget', { hasText: label });

async function cellOf(page: Page, label: string) {
  const grid = await page
    .locator('[data-grid="dashboard"]')
    .boundingBox();
  const box = await widget(page, label).boundingBox();
  if (!grid || !box) throw new Error('missing boxes');
  // 12 cols, 8px gap, 56px rows (see the demo config)
  const unit = (grid.width - 8 * 11) / 12;
  return {
    x: Math.round((box.x - grid.x) / (unit + 8)),
    y: Math.round((box.y - grid.y) / (56 + 8)),
    w: Math.round((box.width + 8) / (unit + 8)),
    h: Math.round((box.height + 8) / (56 + 8)),
  };
}

test.describe('placement grid — spanning dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/placement-grid');
    await expect(widget(page, 'Chart')).toBeVisible();
  });

  test('dragging a widget reflows neighbours and commits on release', async ({ page }) => {
    expect(await cellOf(page, 'KPIs')).toMatchObject({ x: 6, y: 0 });

    // drag KPIs onto Chart's origin: Chart yields (pushes down), gravity settles
    await filmstrip(
      page,
      'grid-reflow',
      widget(page, 'KPIs'),
      [await at(widget(page, 'Chart'), { fx: 0.1, fy: 0.3 })],
      { settle: 80 },
    );

    await expect
      .poll(async () => (await cellOf(page, 'KPIs')).x)
      .toBeLessThan(3);
    // no overlap anywhere after the commit
    const chart = await cellOf(page, 'Chart');
    const kpis = await cellOf(page, 'KPIs');
    expect(kpis.y + kpis.h <= chart.y || chart.y + chart.h <= kpis.y || kpis.x + kpis.w <= chart.x || chart.x + chart.w <= kpis.x).toBe(true);
  });

  test('resize by the corner grip changes spans in whole cells', async ({ page }) => {
    const before = await cellOf(page, 'KPIs');
    const grip = widget(page, 'KPIs').locator('.grip');
    const start = await resolvePoint(grip);
    await drag(page, start, { x: start.x + 120, y: start.y + 60 }, { settle: 80 });

    const after = await cellOf(page, 'KPIs');
    expect(after.w).toBeGreaterThan(before.w);
    expect(Number.isInteger(after.w)).toBe(true);
  });

  test('keyboard: arrows move a cell, Shift+arrows resize', async ({ page }) => {
    const kpis = widget(page, 'KPIs');
    const before = await cellOf(page, 'KPIs');
    await kpis.press('ArrowLeft');
    await expect
      .poll(async () => (await cellOf(page, 'KPIs')).x)
      .toBe(before.x - 1);

    await kpis.press('Shift+ArrowRight');
    await expect
      .poll(async () => (await cellOf(page, 'KPIs')).w)
      .toBe(before.w + 1);
  });

  test('a grid widget over the tray morphs to a row preview and drops in', async ({ page }) => {
    const tray = page.locator('ul[data-list="widget-tray"] li');
    await expect(tray).toHaveCount(2);

    await drag(page, widget(page, 'Feed'), tray.first(), {
      release: false,
      settle: 80,
    });
    // the dragged widget previews as the row it will become
    await expect(page.locator('.widget.as-row')).toHaveCount(1);
    await page.mouse.up();

    await expect(tray).toHaveCount(3);
    await expect(tray.filter({ hasText: 'Feed' })).toHaveCount(1);
    await expect(widget(page, 'Feed')).toHaveCount(0); // left the grid
  });

  test('a tray card drops into the grid at the pointed cell', async ({ page }) => {
    const tray = page.locator('ul[data-list="widget-tray"] li');
    await expect(tray).toHaveCount(2);
    const grid = page.locator('[data-grid="dashboard"]');
    const g = await grid.boundingBox();
    if (!g) throw new Error('no grid box');

    // hovering already previews the incoming drop rect
    await drag(
      page,
      tray.first(),
      { x: g.x + g.width * 0.4, y: g.y + g.height * 0.7 },
      { settle: 80, release: false },
    );
    await expect(grid.locator('.target-cell')).toBeVisible();
    await page.mouse.up();

    await expect(tray).toHaveCount(1);
    await expect(widget(page, 'Notes')).toBeVisible();
  });

  test('compact none: valid cells light up and occupied cells reject', async ({ page }) => {
    const masked = page.locator('[data-grid="masked"]');
    const a = masked.locator('.widget', { hasText: 'A' });
    const b = masked.locator('.widget', { hasText: 'B' });
    const bBox = await b.boundingBox();
    const aBefore = await a.boundingBox();
    if (!bBox || !aBefore) throw new Error('missing boxes');

    // mid-drag the mask cells appear and the projected drop cell highlights
    await drag(page, a, { x: bBox.x + 10, y: bBox.y + 10 }, { release: false, settle: 60 });
    await expect
      .poll(() => masked.locator('.mask-cell').count())
      .toBeGreaterThan(0);
    await expect(masked.locator('.target-cell')).toBeVisible();
    await page.mouse.up();

    // dropped over B (occupied) → rests at the last VALID cell along the path,
    // never overlapping B
    await expect
      .poll(async () => {
        const aBox = await a.boundingBox();
        const bNow = await b.boundingBox();
        if (!aBox || !bNow) return false;
        return aBox.x + aBox.width <= bNow.x + 1;
      })
      .toBe(true);
  });
});

test.describe('placement grid — perf guard', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'CDP performance metrics are Chromium-only',
  );

  test('a grid drag is transform-only between cell crossings', async ({ page }) => {
    await page.goto('/placement-grid');
    await expect(widget(page, 'Chart')).toBeVisible();

    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');

    const start = await resolvePoint(widget(page, 'Feed'));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 10);

    const counts = async () => {
      const { metrics } = (await client.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
    };
    const before = await counts();
    const MOVES = 60;
    for (let i = 0; i < MOVES; i++) {
      // wiggle WITHIN one cell — no crossings, so nothing should re-lay out
      await page.mouse.move(start.x + (i % 8), start.y + 10 + (i % 6));
    }
    const after = await counts();
    await page.mouse.up();

    const delta = after - before;
    console.log(`[perf] grid ${MOVES} within-cell moves → layoutΔ=${delta}`);
    expect(delta).toBeLessThan(10);
  });
});
