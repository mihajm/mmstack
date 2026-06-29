import { expect, test, type Page } from '@playwright/test';
import { at, drag, filmstrip, resolvePoint } from './support/pointer';

const rows = (page: Page) => page.locator('ul[data-list="pointer"] li');
const labels = (page: Page) =>
  rows(page).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').replace(/⠿/g, '').trim()),
  );

const START = ['Auth flow', 'Billing page', 'Search filters', 'Dashboard charts', 'Settings panel'];

test.describe('pointer sortable — single vertical list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await expect(page.getByText('Auth flow')).toBeVisible();
    expect(await labels(page)).toEqual(START);
  });

  test('drags the first row to the end', async ({ page }) => {
    const last = rows(page).last();
    const box = await last.boundingBox();
    const below = { x: box!.x + box!.width / 2, y: box!.y + box!.height + 24 };

    await drag(page, rows(page).first(), below, { steps: 18, settle: 40 });

    await expect.poll(() => labels(page)).toEqual([
      'Billing page',
      'Search filters',
      'Dashboard charts',
      'Settings panel',
      'Auth flow',
    ]);
  });

  test('drags the last row to the top', async ({ page }) => {
    const first = rows(page).first();
    const above = await at(first, { fy: 0.1 });

    await drag(page, rows(page).last(), above, { steps: 18, settle: 40 });

    await expect.poll(() => labels(page)).toEqual([
      'Settings panel',
      'Auth flow',
      'Billing page',
      'Search filters',
      'Dashboard charts',
    ]);
  });

  test('a tiny drag within a row is a no-op (no accidental reorder)', async ({ page }) => {
    const first = await resolvePoint(rows(page).first());
    await drag(page, first, { x: first.x, y: first.y + 6 }, { steps: 4, settle: 30 });
    expect(await labels(page)).toEqual(START);
  });

  test('exposes the dragging hook only while dragging', async ({ page }) => {
    const first = rows(page).first();
    const start = await resolvePoint(first);

    await drag(page, start, { x: start.x, y: start.y + 60 }, {
      release: false,
      settle: 30,
    });
    await expect(rows(page).filter({ hasText: 'Auth flow' })).toHaveClass(/mm-sortable-dragging/);

    await page.mouse.up();
    await expect(page.locator('.mm-sortable-dragging')).toHaveCount(0);
  });

  test('siblings do not jerk on drop — mid-drag position equals the committed position', async ({ page }) => {
    // Regression: displacement must use exact center spacing (incl. the flex gap),
    // else a displaced sibling shifts a few px when transforms clear on commit.
    const start = await resolvePoint(rows(page).first()); // Auth flow (index 0)
    const search = page.getByText('Search filters'); // index 2

    // hold a drag of row 0 down past row 2 so 'Search filters' is displaced
    await drag(page, start, { x: start.x, y: start.y + 130 }, {
      release: false,
      settle: 300, // wait out the 200ms reflow glide so the sibling has settled
    });
    const midTop = (await search.boundingBox())!.y; // displaced (transformed) position
    await page.mouse.up();
    await page.waitForTimeout(80); // commit settles

    const finalTop = (await search.boundingBox())!.y; // committed (laid-out) position
    expect(Math.abs(finalTop - midTop)).toBeLessThan(1.5); // no jerk (was ~the gap, 8px)
  });

  test('commits instantly on drop — nothing animates (siblings already placed)', async ({ page }) => {
    const start = await resolvePoint(rows(page).first());
    await drag(page, start, { x: start.x, y: start.y + 130 }, { steps: 16, settle: 20 });
    await page.waitForTimeout(60); // let the commit flush

    const animating = await rows(page).evaluateAll((els) =>
      els.some((el) => (el as HTMLElement).getAnimations().length > 0),
    );
    expect(animating).toBe(false);
  });

  test('items declare touch-action:none so a touch-drag never scrolls the page', async ({ page }) => {
    const ta = await rows(page)
      .first()
      .evaluate((el) => getComputedStyle(el).touchAction);
    expect(ta).toBe('none');
  });

  test('reorders via a real touch drag (pointerType: touch)', async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    const start = await resolvePoint(rows(page).first());
    const box = await rows(page).last().boundingBox();
    const endY = box!.y + box!.height + 24;

    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: start.x, y: start.y }],
    });
    for (let i = 1; i <= 12; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x, y: start.y + ((endY - start.y) * i) / 12 }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect
      .poll(() => labels(page))
      .toEqual(['Billing page', 'Search filters', 'Dashboard charts', 'Settings panel', 'Auth flow']);
  });

  test('conserves the item set across a reorder (no loss / no duplication)', async ({ page }) => {
    const last = rows(page).last();
    const box = await last.boundingBox();
    const shots = await filmstrip(
      page,
      'pointer-sortable',
      rows(page).first(),
      [
        { x: box!.x + box!.width / 2, y: box!.y - 40 },
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
      ],
      { steps: 16, settle: 60, clip: page.locator('ul[data-list="pointer"]') },
    );
    expect(shots).toHaveLength(2);

    const after = await labels(page);
    expect(after).toHaveLength(START.length);
    expect(new Set(after)).toEqual(new Set(START));
  });
});

test.describe('pointer sortable — auto-scroll', () => {
  const sbox = (page: Page) => page.locator('.scroll-box');
  const sitems = (page: Page) => page.locator('ul[data-list="scroll"] li');

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await sbox(page).scrollIntoViewIfNeeded();
    await expect(sitems(page).first()).toHaveText(/Item 1/);
  });

  test('holding near the bottom edge scrolls the container', async ({ page }) => {
    const before = await sbox(page).evaluate((el) => el.scrollTop);
    expect(before).toBe(0);

    const start = await resolvePoint(sitems(page).first());
    const box = (await sbox(page).boundingBox())!;
    // drag the first item down to the bottom edge and HOLD (no release) so the
    // rAF auto-scroll loop runs
    await drag(page, start, { x: start.x, y: box.y + box.height - 6 }, {
      release: false,
      settle: 400,
    });
    const after = await sbox(page).evaluate((el) => el.scrollTop);
    await page.mouse.up();

    expect(after).toBeGreaterThan(before); // the container scrolled down
  });

  test('a drop after auto-scroll still commits (scroll-compensated collision)', async ({ page }) => {
    const start = await resolvePoint(sitems(page).first());
    const box = (await sbox(page).boundingBox())!;
    await drag(page, start, { x: start.x, y: box.y + box.height - 6 }, {
      settle: 400, // auto-scrolls while held, then releases (commit)
    });
    // Item 1 left the top — it moved down into the scrolled region
    await expect.poll(() => sitems(page).first().textContent()).not.toContain('Item 1');
    // set conserved
    const labels = await sitems(page).evaluateAll((els) =>
      els.map((e) => (e.textContent ?? '').trim()),
    );
    expect(labels).toHaveLength(15);
    expect(new Set(labels).size).toBe(15);
  });
});

test.describe('pointer sortable — nested lists', () => {
  const nested1 = (page: Page) => page.locator('ul[data-list="check-1"] li');
  const outerCards = (page: Page) =>
    page.locator('ul[data-list="outer"] > li');
  const cardOrder = (page: Page) =>
    outerCards(page).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-card')),
    );

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await page.getByText('Step A').scrollIntoViewIfNeeded();
    await expect(page.getByText('Step A')).toBeVisible();
  });

  test('dragging a nested item reorders the nested list, NOT the outer', async ({ page }) => {
    const before = await cardOrder(page);
    const stepA = nested1(page).filter({ hasText: 'Step A' });
    const stepB = nested1(page).filter({ hasText: 'Step B' });
    await drag(page, stepA, await at(stepB, { fy: 0.9 }), { steps: 16, settle: 40 });

    await expect
      .poll(() =>
        nested1(page).evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim())),
      )
      .toEqual(['Step B', 'Step A']); // inner reordered (inner claimed the gesture)
    expect(await cardOrder(page)).toEqual(before); // outer untouched
  });

  test('moves a checklist item between cards (nested cross-list)', async ({ page }) => {
    const labels = (sel: string) => () =>
      page
        .locator(sel)
        .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    const stepA = nested1(page).filter({ hasText: 'Step A' });
    const target = page.locator('ul[data-list="check-2"]');
    const box = (await target.boundingBox())!;
    await drag(page, stepA, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, {
      steps: 20,
      settle: 60,
    });
    await expect.poll(labels('ul[data-list="check-2"] li')).toContain('Step A');
    await expect.poll(labels('ul[data-list="check-1"] li')).not.toContain('Step A');
  });

  test('dragging a card by its header reorders the OUTER list', async ({ page }) => {
    const header = page.locator('[data-card="1"] > .card-header'); // the outer drag handle
    const box = (await outerCards(page).nth(1).boundingBox())!; // card 2
    await drag(page, header, { x: box.x + box.width / 2, y: box.y + box.height - 8 }, {
      steps: 16,
      settle: 40,
    });
    await expect.poll(() => cardOrder(page)).toEqual(['2', '1', '3']);
  });
});

test.describe('pointer sortable — nested containers (cross-level, one group)', () => {
  const innerRows = (page: Page) => () =>
    page
      .locator('ul[data-list="t-inner"] li')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  const outerRows = (page: Page) => () =>
    page
      .locator('ul[data-list="t-outer"] > li')
      .evaluateAll((els) => els.map((e) => (e.firstChild?.textContent ?? '').trim()));

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await page.getByText('Nested A').scrollIntoViewIfNeeded();
    await expect(page.getByText('Nested A')).toBeVisible();
  });

  test('OUTER item -> INNER container (down a level)', async ({ page }) => {
    const item1 = page
      .locator('ul[data-list="t-outer"] > li', { hasText: 'Item 1' })
      .first();
    const box = (await page.locator('ul[data-list="t-inner"]').boundingBox())!;
    await drag(page, item1, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, {
      steps: 24,
      settle: 80,
    });
    await expect.poll(innerRows(page)).toContain('Item 1');
  });

  test('INNER item -> OUTER container (up a level)', async ({ page }) => {
    const nestedA = page.locator('ul[data-list="t-inner"] li', { hasText: 'Nested A' });
    const box = (await page.locator('ul[data-list="t-outer"] > li').last().boundingBox())!;
    await drag(page, nestedA, { x: box.x + box.width / 2, y: box.y + box.height - 6 }, {
      steps: 24,
      settle: 80,
    });
    await expect.poll(outerRows(page)).toContain('Nested A');
  });
});

test.describe('pointer sortable — keyboard + a11y', () => {
  const jumpMod = process.platform === 'darwin' ? 'Meta' : 'Control';

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await expect(page.getByText('Auth flow')).toBeVisible();
    expect(await labels(page)).toEqual(START);
  });

  test('arrow keys move the focused item one step', async ({ page }) => {
    await rows(page).first().focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => labels(page)).toEqual([
      'Billing page',
      'Auth flow',
      'Search filters',
      'Dashboard charts',
      'Settings panel',
    ]);
  });

  test('jump-modifier + arrow moves the item to the end', async ({ page }) => {
    await rows(page).first().focus();
    await page.keyboard.press(`${jumpMod}+ArrowDown`);
    await expect.poll(() => labels(page)).toEqual([
      'Billing page',
      'Search filters',
      'Dashboard charts',
      'Settings panel',
      'Auth flow',
    ]);
  });

  test('the moved item keeps focus across the reorder', async ({ page }) => {
    await rows(page).first().focus();
    await page.keyboard.press('ArrowDown');
    const focusedText = await page.evaluate(() =>
      (document.activeElement?.textContent ?? '').replace(/⠿/g, '').trim(),
    );
    expect(focusedText).toContain('Auth flow'); // focus followed the moved item
  });

  test('announces the move to a live region (screen readers)', async ({ page }) => {
    await rows(page).first().focus();
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => page.locator('[aria-live="polite"]').first().textContent())
      .toContain('Moved to position');
  });
});

test.describe('pointer sortable — cross-list (shared group)', () => {
  const todo = (page: Page) => page.locator('ul[data-list="todo"] li');
  const doing = (page: Page) => page.locator('ul[data-list="doing"] li');
  const texts = (loc: ReturnType<typeof todo>) =>
    loc.evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await todo(page).first().scrollIntoViewIfNeeded(); // board sits below the fold
    await expect(page.getByText('Spec API')).toBeVisible();
  });

  test('drags a card from one column into the other', async ({ page }) => {
    const card = todo(page).filter({ hasText: 'Write docs' });
    const box = (await doing(page).first().boundingBox())!; // drop near the top of "doing"
    await drag(page, card, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, {
      steps: 20,
      settle: 60,
    });

    await expect.poll(() => texts(doing(page))).toContain('Write docs'); // arrived
    await expect.poll(() => texts(todo(page))).not.toContain('Write docs'); // left
  });

  test('does not clobber the container padding when idle (CSS var, not imposed padding)', async ({ page }) => {
    const pb = await page
      .locator('ul[data-list="todo"]')
      .evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(pb).toBe('8px'); // the demo's own padding, intact — engine only sets a var
  });

  test('conserves the combined card set across a cross-list move', async ({ page }) => {
    const before = [...(await texts(todo(page))), ...(await texts(doing(page)))].sort();
    const card = doing(page).filter({ hasText: 'Review PR' });
    const box = (await todo(page).first().boundingBox())!;
    await drag(page, card, { x: box.x + box.width / 2, y: box.y + box.height + 20 }, {
      steps: 20,
      settle: 60,
    });
    await expect
      .poll(async () =>
        [...(await texts(todo(page))), ...(await texts(doing(page)))].sort(),
      )
      .toEqual(before); // same set, no loss / no duplication
  });
});

test.describe('pointer sortable — drag handle', () => {
  const hrows = (page: Page) => page.locator('ul[data-list="pointer-handle"] li');
  const hlabels = (page: Page) =>
    hrows(page).evaluateAll((els) =>
      els.map((e) => (e.textContent ?? '').replace(/⠿/g, '').trim()),
    );
  const H = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await expect(page.getByText('Alpha')).toBeVisible();
    expect(await hlabels(page)).toEqual(H);
  });

  test('dragging the handle reorders', async ({ page }) => {
    const grip = hrows(page).first().locator('.grip');
    const box = await hrows(page).last().boundingBox();
    await drag(page, grip, { x: box!.x + box!.width / 2, y: box!.y + box!.height + 24 }, {
      steps: 16,
      settle: 40,
    });
    await expect
      .poll(() => hlabels(page))
      .toEqual(['Beta', 'Gamma', 'Delta', 'Epsilon', 'Alpha']);
  });

  test('dragging the item body does NOT start a drag (handle-only surface)', async ({ page }) => {
    const box = await hrows(page).first().boundingBox();
    // right side, away from the left-edge grip
    const body = { x: box!.x + box!.width - 12, y: box!.y + box!.height / 2 };
    await drag(page, body, { x: body.x, y: body.y + 160 }, { steps: 16, settle: 40 });
    expect(await hlabels(page)).toEqual(H); // unchanged
  });

  test('touch-action:none is scoped to the handle, body stays scrollable', async ({ page }) => {
    const item = hrows(page).first();
    const grip = item.locator('.grip');
    expect(await grip.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    expect(await item.evaluate((el) => getComputedStyle(el).touchAction)).not.toBe('none');
  });

  test('only the handle reads as grabbable (body cursor is not grab)', async ({ page }) => {
    const item = hrows(page).first();
    const grip = item.locator('.grip');
    expect(await grip.evaluate((el) => getComputedStyle(el).cursor)).toBe('grab');
    expect(await item.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('grab');
  });
});

test.describe('pointer sortable — horizontal list (axis: x)', () => {
  const chips = (page: Page) => page.locator('ul[data-list="pointer-h"] li');
  const chipLabels = (page: Page) => chips(page).allInnerTexts();
  const H_START = ['urgent', 'design', 'backend', 'docs', 'wontfix'];

  test.beforeEach(async ({ page }) => {
    await page.goto('/sortable-pointer');
    await chips(page).first().scrollIntoViewIfNeeded(); // list sits below the fold
    await expect(page.getByText('urgent')).toBeVisible();
    expect(await chipLabels(page)).toEqual(H_START);
  });

  test('drags the first chip to the end along x', async ({ page }) => {
    const last = chips(page).last();
    const box = await last.boundingBox();
    const past = { x: box!.x + box!.width + 24, y: box!.y + box!.height / 2 };

    await drag(page, chips(page).first(), past, { steps: 18, settle: 40 });

    await expect
      .poll(() => chipLabels(page))
      .toEqual(['design', 'backend', 'docs', 'wontfix', 'urgent']);
  });

  test('drags the last chip to the start along x', async ({ page }) => {
    const first = chips(page).first();
    const before = await at(first, { fx: 0.1 });

    await drag(page, chips(page).last(), before, { steps: 18, settle: 40 });

    await expect
      .poll(() => chipLabels(page))
      .toEqual(['wontfix', 'urgent', 'design', 'backend', 'docs']);
  });

  test('a tiny horizontal nudge is a no-op', async ({ page }) => {
    const first = await resolvePoint(chips(page).first());
    await drag(page, first, { x: first.x + 6, y: first.y }, { steps: 4, settle: 30 });
    expect(await chipLabels(page)).toEqual(H_START);
  });

  test('variable-width siblings do not jerk on drop (footprint, not center, shift)', async ({ page }) => {
    const start = await resolvePoint(chips(page).first()); // 'urgent' (idx 0)
    const design = page.getByText('design'); // idx 1, different width
    const box = (await chips(page).last().boundingBox())!;

    await drag(page, start, { x: box.x + box.width / 2, y: start.y }, {
      release: false,
      settle: 300, // wait out the glide
    });
    const midX = (await design.boundingBox())!.x; // displaced position
    await page.mouse.up();
    await page.waitForTimeout(80);

    const finalX = (await design.boundingBox())!.x; // committed position
    expect(Math.abs(finalX - midX)).toBeLessThan(1.5); // no jerk
  });
});
