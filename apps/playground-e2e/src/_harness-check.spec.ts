import { expect, test } from '@playwright/test';
import { drag, filmstrip, resolvePoint } from './support/pointer';

/**
 * Validates the pointer harness mechanics (NOT the dnd engine): a stepped
 * pointer gesture produces real, observable motion and the filmstrip captures
 * a frame per waypoint. Drives /canvas because it's pointer-based today.
 * Throwaway — delete once the sortable pointer engine has its own specs.
 */
test.describe('pointer harness self-check', () => {
  test('stepped drag moves a pointer-driven element and films each waypoint', async ({ page }) => {
    await page.goto('/canvas');
    const widget = page.locator('mm-canvas-widget').first();
    await expect(widget).toBeVisible();

    const before = await widget.boundingBox();
    expect(before).not.toBeNull();
    const start = await resolvePoint(widget);

    // three waypoints down-right, settle so layout commits before each shot
    const shots = await filmstrip(
      page,
      'selfcheck',
      start,
      [
        { x: start.x + 40, y: start.y + 30 },
        { x: start.x + 90, y: start.y + 70 },
        { x: start.x + 140, y: start.y + 110 },
      ],
      { steps: 8, settle: 30, clip: page.locator('.viewport') },
    );

    expect(shots).toHaveLength(3);

    const after = await widget.boundingBox();
    expect(after).not.toBeNull();
    // real motion in both axes (proves pointermove reached the engine)
    expect(after!.x).toBeGreaterThan(before!.x + 50);
    expect(after!.y).toBeGreaterThan(before!.y + 50);
  });

  test('open-ended gesture (release:false) leaves the element mid-drag', async ({ page }) => {
    await page.goto('/canvas');
    const widget = page.locator('mm-canvas-widget').first();
    const start = await resolvePoint(widget);

    await drag(page, start, { x: start.x + 60, y: start.y + 40 }, { release: false, settle: 30 });
    await expect(widget).toHaveClass(/moving/); // engine reports an active gesture
    await page.mouse.up();
    await expect(widget).not.toHaveClass(/moving/);
  });
});
