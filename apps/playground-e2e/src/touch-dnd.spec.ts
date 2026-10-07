import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Touch behaviour of pointer lists (/touch-dnd): axis-aware `touch-action` and
 * the opt-in long-press. Real touch input (native scrolling, touch-action) is
 * only scriptable through CDP, so those runs are Chromium-only; the long-press
 * gate itself runs in every browser through synthetic touch PointerEvents.
 */

const list = (page: Page, name: string) =>
  page.locator(`ul[data-list="${name}"]`);
const items = (page: Page, name: string) => list(page, name).locator('li');
const labels = (page: Page, name: string) =>
  items(page, name).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').trim()),
  );
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function center(loc: Locator) {
  const box = await loc.boundingBox();
  if (!box) throw new Error('no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, h: box.height };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 700 });
  await page.goto('/touch-dnd');
  await expect(items(page, 'long-press')).toHaveCount(4);
  // the pointer gesture is wired after first render
  await page.waitForTimeout(100);
});

test.describe('touch-action', () => {
  test('a vertical list without a handle leaves horizontal panning to the page; long-press lists use manipulation', async ({ page }) => {
    const ta = (name: string) =>
      items(page, name).evaluateAll((els) =>
        els.map((e) => getComputedStyle(e).touchAction),
      );
    expect(await ta('axis')).toEqual(Array(4).fill('pan-x'));
    expect(await ta('long-press')).toEqual(Array(4).fill('manipulation'));
  });
});

/** Synthetic touch PointerEvents: exercises the gate in any engine (no native scrolling). */
async function synthetic(page: Page, target: Locator) {
  const fire = (type: string, x: number, y: number, pointerType = 'touch') =>
    target.evaluate(
      (el, a) => {
        el.dispatchEvent(
          new PointerEvent(a.type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: a.pointerType,
            isPrimary: true,
            clientX: a.x,
            clientY: a.y,
            button: a.type === 'pointermove' ? -1 : 0,
            buttons: a.type === 'pointerup' ? 0 : 1,
          }),
        );
      },
      { type, x, y, pointerType },
    );
  return { fire };
}

test.describe('long-press gate (synthetic touch, every browser)', () => {
  test('a touch that rests for the delay, then moves, reorders', async ({ page }) => {
    const first = items(page, 'long-press').first();
    const third = items(page, 'long-press').nth(2);
    const a = await center(first);
    const b = await center(third);
    const { fire } = await synthetic(page, first);

    await fire('pointerdown', a.x, a.y);
    await page.waitForTimeout(150);
    await fire('pointermove', a.x + 3, a.y + 4);
    // mid-delay: no drag yet, though 5px is the activation threshold (and within the tolerance)
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '');
    await page.waitForTimeout(250);
    for (let i = 1; i <= 8; i++) {
      await fire('pointermove', a.x, a.y + ((b.y + b.h / 2 - a.y) * i) / 8);
      await page.waitForTimeout(16);
    }
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '1');
    await fire('pointerup', a.x, b.y + b.h / 2);
    await expect
      .poll(() => labels(page, 'long-press'))
      .toEqual(['Hold Two', 'Hold Three', 'Hold One', 'Hold Four']);
  });

  test('a touch that moves before the delay never drags', async ({ page }) => {
    const first = items(page, 'long-press').first();
    const a = await center(first);
    const { fire } = await synthetic(page, first);

    await fire('pointerdown', a.x, a.y);
    await fire('pointermove', a.x, a.y + 30); // past the tolerance: a scroll
    await page.waitForTimeout(400);
    for (let i = 1; i <= 6; i++) {
      await fire('pointermove', a.x, a.y + 30 + i * 20);
      await page.waitForTimeout(16);
    }
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '');
    await fire('pointerup', a.x, a.y + 150);
    await page.waitForTimeout(50);
    expect(await labels(page, 'long-press')).toEqual([
      'Hold One',
      'Hold Two',
      'Hold Three',
      'Hold Four',
    ]);
  });

  test('the mouse is never delayed', async ({ page }) => {
    const first = items(page, 'long-press').first();
    const a = await center(first);
    const b = await center(items(page, 'long-press').nth(2));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x, a.y + 10, { steps: 2 });
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '1');
    await page.mouse.move(a.x, b.y + b.h / 2, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(() => labels(page, 'long-press'))
      .toEqual(['Hold Two', 'Hold Three', 'Hold One', 'Hold Four']);
  });
});

/** Real touch through CDP: native scrolling and touch-action apply. */
async function cdpTouch(page: Page) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const send = (type: string, x?: number, y?: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart' | 'touchMove' | 'touchEnd',
      touchPoints: x === undefined ? [] : [{ x, y: y as number, id: 1 }],
    });
  return {
    start: (x: number, y: number) => send('touchStart', x, y),
    move: (x: number, y: number) => send('touchMove', x, y),
    end: () => send('touchEnd'),
    /** Glide in small steps, a frame apart, like a finger. */
    async glide(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
      for (let i = 1; i <= steps; i++) {
        await send(
          'touchMove',
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps,
        );
        await page.waitForTimeout(16);
      }
    },
  };
}

test.describe('real touch (Chromium, CDP)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP touch input is Chromium-only');
  test.use({ hasTouch: true });
  // start mid-page so a stray scroll in either direction shows up
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(() => scrollY(page)).toBe(120);
  });

  test('a vertical list drags on touch and the page does not scroll mid-drag, even with a sideways drift', async ({ page }) => {
    const first = items(page, 'axis').first();
    const a = await center(first);
    const b = await center(items(page, 'axis').nth(2));
    const t = await cdpTouch(page);
    const before = await scrollY(page);

    await t.start(a.x, a.y);
    await t.glide(a, { x: a.x + 12, y: b.y + b.h / 2 });
    expect(await scrollY(page)).toBe(before);
    await t.end();

    await expect
      .poll(() => labels(page, 'axis'))
      .toEqual(['Axis Two', 'Axis Three', 'Axis One', 'Axis Four']);
    expect(await scrollY(page)).toBe(before);
  });

  test('long-press: a quick swipe over the list scrolls the page and starts no drag', async ({ page }) => {
    const first = items(page, 'long-press').first();
    const a = await center(first);
    const t = await cdpTouch(page);
    const before = await scrollY(page);

    await t.start(a.x, a.y);
    await t.glide(a, { x: a.x, y: a.y - 200 }); // finger up: the page scrolls down
    await t.end();

    await expect.poll(() => scrollY(page)).toBeGreaterThan(before + 50);
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '');
    expect(await labels(page, 'long-press')).toEqual([
      'Hold One',
      'Hold Two',
      'Hold Three',
      'Hold Four',
    ]);
  });

  test('long-press: hold, then drag; the page stays put for the whole drag', async ({ page }) => {
    const first = items(page, 'long-press').first();
    const a = await center(first);
    const b = await center(items(page, 'long-press').nth(2));
    const t = await cdpTouch(page);
    const before = await scrollY(page);

    await t.start(a.x, a.y);
    await page.waitForTimeout(400);
    await t.glide(a, { x: a.x, y: b.y + b.h / 2 });
    await expect(list(page, 'long-press')).toHaveAttribute('data-active', '1');
    expect(await scrollY(page)).toBe(before);
    await t.end();

    await expect
      .poll(() => labels(page, 'long-press'))
      .toEqual(['Hold Two', 'Hold Three', 'Hold One', 'Hold Four']);
    expect(await scrollY(page)).toBe(before);
  });
});
