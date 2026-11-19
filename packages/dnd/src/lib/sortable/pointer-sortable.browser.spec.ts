import { userEvent } from 'vitest/browser';

import {
  at,
  byText,
  cdpTouch,
  center,
  drag,
  labels,
  mount,
  resetPointer,
  until,
  up,
  wait,
  notChromium,
} from '../testing/browser';
import { PointerSortableExample } from '../testing/fixtures/pointer-sortable';

const START = [
  'Auth flow',
  'Billing page',
  'Search filters',
  'Dashboard charts',
  'Settings panel',
];

let root: HTMLElement;
const q = (sel: string) => root.querySelector(sel) as HTMLElement;
const all = (sel: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(sel));
const rows = () => all('ul[data-list="pointer"] li');
const order = () => labels(root, 'ul[data-list="pointer"] li');

beforeEach(async () => {
  root = (await mount(PointerSortableExample)).nativeElement as HTMLElement;
});
afterEach(resetPointer);

describe('pointer sortable: single vertical list', () => {
  beforeEach(() => expect(order()).toEqual(START));

  it('drags the first row to the end', async () => {
    const r = rows().at(-1)!.getBoundingClientRect();
    const below = { x: r.left + r.width / 2, y: r.bottom + 24 };
    await drag(rows()[0], below, { steps: 18, settle: 40 });
    await until(() =>
      expect(order()).toEqual([
        'Billing page',
        'Search filters',
        'Dashboard charts',
        'Settings panel',
        'Auth flow',
      ]),
    );
  });

  it('drags the last row to the top', async () => {
    await drag(rows().at(-1)!, at(rows()[0], { fy: 0.1 }), {
      steps: 18,
      settle: 40,
    });
    await until(() =>
      expect(order()).toEqual([
        'Settings panel',
        'Auth flow',
        'Billing page',
        'Search filters',
        'Dashboard charts',
      ]),
    );
  });

  it('a tiny drag within a row is a no-op (no accidental reorder)', async () => {
    const first = center(rows()[0]);
    await drag(first, { x: first.x, y: first.y + 6 }, { steps: 4, settle: 30 });
    expect(order()).toEqual(START);
  });

  it('exposes the dragging hook only while dragging', async () => {
    const start = center(rows()[0]);
    await drag(
      start,
      { x: start.x, y: start.y + 60 },
      { release: false, settle: 30 },
    );
    await until(() =>
      expect(
        byText(root, 'ul[data-list="pointer"] li', 'Auth flow').classList,
      ).toContain('mm-sortable-dragging'),
    );
    await up();
    await until(() => expect(all('.mm-sortable-dragging')).toHaveLength(0));
  });

  it('siblings do not jerk on drop: mid-drag position equals the committed position', async () => {
    const start = center(rows()[0]);
    const search = byText(root, 'ul[data-list="pointer"] li', 'Search filters');
    await drag(
      start,
      { x: start.x, y: start.y + 130 },
      { release: false, settle: 300 },
    );
    const midTop = search.getBoundingClientRect().top;
    await up();
    await wait(80);
    const finalTop = search.getBoundingClientRect().top;
    expect(Math.abs(finalTop - midTop)).toBeLessThan(1.5);
  });

  it('commits instantly on drop: nothing animates (siblings already placed)', async () => {
    const start = center(rows()[0]);
    await drag(
      start,
      { x: start.x, y: start.y + 130 },
      { steps: 16, settle: 20 },
    );
    await wait(60);
    expect(rows().some((el) => el.getAnimations().length > 0)).toBe(false);
  });

  it('items of a vertical list declare touch-action:pan-x so a touch-drag never scrolls the page vertically', () => {
    expect(getComputedStyle(rows()[0]).touchAction).toBe('pan-x');
  });

  it.skipIf(notChromium)(
    'reorders via a real touch drag (pointerType: touch)',
    async () => {
      const t = cdpTouch();
      const start = center(rows()[0]);
      const endY = rows().at(-1)!.getBoundingClientRect().bottom + 24;
      await t.start(start);
      for (let i = 1; i <= 12; i++)
        await t.move({ x: start.x, y: start.y + ((endY - start.y) * i) / 12 });
      await t.end();
      await until(() =>
        expect(order()).toEqual([
          'Billing page',
          'Search filters',
          'Dashboard charts',
          'Settings panel',
          'Auth flow',
        ]),
      );
    },
  );

  it('conserves the item set across a reorder (no loss / no duplication)', async () => {
    const r = rows().at(-1)!.getBoundingClientRect();
    const x = r.left + r.width / 2;
    await drag(
      rows()[0],
      [
        { x, y: r.top - 40 },
        { x, y: r.top + r.height / 2 },
      ],
      { steps: 16, settle: 60 },
    );
    const after = order();
    expect(after).toHaveLength(START.length);
    expect(new Set(after)).toEqual(new Set(START));
  });
});

describe('pointer sortable: auto-scroll', () => {
  const box = () => q('.scroll-box');
  const items = () => all('ul[data-list="scroll"] li');

  beforeEach(() => {
    box().scrollIntoView({ block: 'center' });
    expect(items()[0].textContent).toMatch(/Item 1/);
  });

  it('holding near the bottom edge scrolls the container', async () => {
    expect(box().scrollTop).toBe(0);
    const start = center(items()[0]);
    const b = box().getBoundingClientRect();
    await drag(
      start,
      { x: start.x, y: b.bottom - 6 },
      { release: false, settle: 400 },
    );
    const after = box().scrollTop;
    await up();
    expect(after).toBeGreaterThan(0);
  });

  it('a drop after auto-scroll still commits (scroll-compensated collision)', async () => {
    const start = center(items()[0]);
    const b = box().getBoundingClientRect();
    await drag(start, { x: start.x, y: b.bottom - 6 }, { settle: 400 });
    await until(() => expect(items()[0].textContent).not.toContain('Item 1'));
    const texts = items().map((e) => (e.textContent ?? '').trim());
    expect(texts).toHaveLength(15);
    expect(new Set(texts).size).toBe(15);
  });
});

describe('pointer sortable: nested lists', () => {
  const nested1 = () => labels(root, 'ul[data-list="check-1"] li');
  const cardOrder = () =>
    all('ul[data-list="outer"] > li').map((e) => e.getAttribute('data-card'));

  beforeEach(() =>
    byText(root, 'li', 'Step A').scrollIntoView({ block: 'center' }),
  );

  it('dragging a nested item reorders the nested list, NOT the outer', async () => {
    const before = cardOrder();
    const list = q('ul[data-list="check-1"]');
    await drag(
      byText(list, 'li', 'Step A'),
      at(byText(list, 'li', 'Step B'), { fy: 0.9 }),
      {
        steps: 16,
        settle: 40,
      },
    );
    await until(() => expect(nested1()).toEqual(['Step B', 'Step A']));
    expect(cardOrder()).toEqual(before);
  });

  it('moves a checklist item between cards (nested cross-list)', async () => {
    const stepA = byText(q('ul[data-list="check-1"]'), 'li', 'Step A');
    await drag(stepA, center(q('ul[data-list="check-2"]')), {
      steps: 20,
      settle: 60,
    });
    await until(() => {
      expect(labels(root, 'ul[data-list="check-2"] li')).toContain('Step A');
      expect(nested1()).not.toContain('Step A');
    });
  });

  it('dragging a card by its header reorders the OUTER list', async () => {
    const header = q('[data-card="1"] > .card-header');
    const r = all('ul[data-list="outer"] > li')[1].getBoundingClientRect();
    await drag(
      header,
      { x: r.left + r.width / 2, y: r.bottom - 8 },
      { steps: 16, settle: 40 },
    );
    await until(() => expect(cardOrder()).toEqual(['2', '1', '3']));
  });
});

describe('pointer sortable: nested containers (cross-level, one group)', () => {
  const innerRows = () => labels(root, 'ul[data-list="t-inner"] li');
  const outerRows = () =>
    all('ul[data-list="t-outer"] > li').map((e) =>
      (e.firstChild?.textContent ?? '').trim(),
    );

  beforeEach(() =>
    byText(root, 'li', 'Nested A').scrollIntoView({ block: 'center' }),
  );

  it('OUTER item -> INNER container (down a level)', async () => {
    const item1 = byText(root, 'ul[data-list="t-outer"] > li', 'Item 1');
    await drag(item1, center(q('ul[data-list="t-inner"]')), {
      steps: 24,
      settle: 80,
    });
    await until(() => expect(innerRows()).toContain('Item 1'));
  });

  it('INNER item -> OUTER container (up a level)', async () => {
    const nestedA = byText(q('ul[data-list="t-inner"]'), 'li', 'Nested A');
    const r = all('ul[data-list="t-outer"] > li')
      .at(-1)!
      .getBoundingClientRect();
    await drag(
      nestedA,
      { x: r.left + r.width / 2, y: r.bottom - 6 },
      { steps: 24, settle: 80 },
    );
    await until(() => expect(outerRows()).toContain('Nested A'));
  });
});

describe('pointer sortable: keyboard + a11y', () => {
  const mac = /Mac|iPhone|iPad|iPod/.test(
    navigator.platform || navigator.userAgent,
  );
  const jumpMod = mac ? 'Meta' : 'Control';

  beforeEach(() => expect(order()).toEqual(START));

  it('arrow keys move the focused item one step', async () => {
    rows()[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    await until(() =>
      expect(order()).toEqual([
        'Billing page',
        'Auth flow',
        'Search filters',
        'Dashboard charts',
        'Settings panel',
      ]),
    );
  });

  it('jump-modifier + arrow moves the item to the end', async () => {
    rows()[0].focus();
    await userEvent.keyboard(`{${jumpMod}>}{ArrowDown}{/${jumpMod}}`);
    await until(() =>
      expect(order()).toEqual([
        'Billing page',
        'Search filters',
        'Dashboard charts',
        'Settings panel',
        'Auth flow',
      ]),
    );
  });

  it('the moved item keeps focus across the reorder', async () => {
    rows()[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    await until(() =>
      expect(
        (document.activeElement?.textContent ?? '').replace(/⠿/g, '').trim(),
      ).toContain('Auth flow'),
    );
  });

  it('announces the move to a live region (screen readers)', async () => {
    rows()[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    await until(() =>
      expect(
        document.querySelector('[aria-live="polite"]')?.textContent,
      ).toContain('Moved to position'),
    );
  });
});

describe('pointer sortable: cross-list (shared group)', () => {
  const todo = () => q('ul[data-list="todo"]');
  const doing = () => q('ul[data-list="doing"]');
  const both = () =>
    [
      ...labels(root, 'ul[data-list="todo"] li'),
      ...labels(root, 'ul[data-list="doing"] li'),
    ].sort();

  beforeEach(() => todo().scrollIntoView({ block: 'center' }));

  it('drags a card from one column into the other', async () => {
    const card = byText(todo(), 'li', 'Write docs');
    await drag(card, center(doing().querySelector('li') as HTMLElement), {
      steps: 20,
      settle: 60,
    });
    await until(() => {
      expect(labels(doing(), 'li')).toContain('Write docs');
      expect(labels(todo(), 'li')).not.toContain('Write docs');
    });
  });

  it('the target keeps its drag-start measures: a pointer between a row and its displaced spot lands below that row', async () => {
    const [build, review] = Array.from(doing().querySelectorAll('li'));
    const restBuild = center(build);
    const restReview = center(review);
    const card = byText(todo(), 'li', 'Write docs');
    // open the gap at the top of "doing" first, so its rows sit displaced
    await drag(
      card,
      [
        { x: restBuild.x, y: build.getBoundingClientRect().top + 2 },
        { x: restBuild.x, y: (restBuild.y + restReview.y) / 2 },
      ],
      { steps: 12, settle: 300 },
    );
    await until(() =>
      expect(labels(doing(), 'li')).toEqual([
        'Build engine',
        'Write docs',
        'Review PR',
      ]),
    );
  });

  it('does not clobber the container padding when idle (CSS var, not imposed padding)', () => {
    expect(getComputedStyle(todo()).paddingBottom).toBe('8px');
  });

  it('conserves the combined card set across a cross-list move', async () => {
    const before = both();
    const card = byText(doing(), 'li', 'Review PR');
    const r = (
      todo().querySelector('li') as HTMLElement
    ).getBoundingClientRect();
    await drag(
      card,
      { x: r.left + r.width / 2, y: r.bottom + 20 },
      { steps: 20, settle: 60 },
    );
    await until(() => expect(both()).toEqual(before));
  });
});

describe('pointer sortable: drag handle', () => {
  const hrows = () => all('ul[data-list="pointer-handle"] li');
  const hlabels = () => labels(root, 'ul[data-list="pointer-handle"] li');
  const H = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

  beforeEach(() => expect(hlabels()).toEqual(H));

  it('dragging the handle reorders', async () => {
    const grip = hrows()[0].querySelector('.grip') as HTMLElement;
    const r = hrows().at(-1)!.getBoundingClientRect();
    await drag(
      grip,
      { x: r.left + r.width / 2, y: r.bottom + 24 },
      { steps: 16, settle: 40 },
    );
    await until(() =>
      expect(hlabels()).toEqual(['Beta', 'Gamma', 'Delta', 'Epsilon', 'Alpha']),
    );
  });

  it('dragging the item body does NOT start a drag (handle-only surface)', async () => {
    const r = hrows()[0].getBoundingClientRect();
    const body = { x: r.right - 12, y: r.top + r.height / 2 };
    await drag(body, { x: body.x, y: body.y + 160 }, { steps: 16, settle: 40 });
    expect(hlabels()).toEqual(H);
  });

  it('touch-action:none is scoped to the handle, body stays scrollable', () => {
    const item = hrows()[0];
    expect(
      getComputedStyle(item.querySelector('.grip') as Element).touchAction,
    ).toBe('none');
    expect(getComputedStyle(item).touchAction).not.toBe('none');
  });

  it('only the handle reads as grabbable (body cursor is not grab)', () => {
    const item = hrows()[0];
    expect(
      getComputedStyle(item.querySelector('.grip') as Element).cursor,
    ).toBe('grab');
    expect(getComputedStyle(item).cursor).not.toBe('grab');
  });
});

describe('pointer sortable: horizontal list (axis: x)', () => {
  const chips = () => all('ul[data-list="pointer-h"] li');
  const chipLabels = () => chips().map((e) => e.innerText.trim());
  const H_START = ['urgent', 'design', 'backend', 'docs', 'wontfix'];

  beforeEach(() => {
    chips()[0].scrollIntoView({ block: 'center' });
    expect(chipLabels()).toEqual(H_START);
  });

  it('drags the first chip to the end along x', async () => {
    const r = chips().at(-1)!.getBoundingClientRect();
    await drag(
      chips()[0],
      { x: r.right + 24, y: r.top + r.height / 2 },
      {
        steps: 18,
        settle: 40,
      },
    );
    await until(() =>
      expect(chipLabels()).toEqual([
        'design',
        'backend',
        'docs',
        'wontfix',
        'urgent',
      ]),
    );
  });

  it('drags the last chip to the start along x', async () => {
    await drag(chips().at(-1)!, at(chips()[0], { fx: 0.1 }), {
      steps: 18,
      settle: 40,
    });
    await until(() =>
      expect(chipLabels()).toEqual([
        'wontfix',
        'urgent',
        'design',
        'backend',
        'docs',
      ]),
    );
  });

  it('a tiny horizontal nudge is a no-op', async () => {
    const first = center(chips()[0]);
    await drag(first, { x: first.x + 6, y: first.y }, { steps: 4, settle: 30 });
    expect(chipLabels()).toEqual(H_START);
  });

  it('variable-width siblings do not jerk on drop (footprint, not center, shift)', async () => {
    const start = center(chips()[0]);
    const design = byText(root, 'ul[data-list="pointer-h"] li', 'design');
    const r = chips().at(-1)!.getBoundingClientRect();
    await drag(
      start,
      { x: r.left + r.width / 2, y: start.y },
      { release: false, settle: 300 },
    );
    const midX = design.getBoundingClientRect().left;
    await up();
    await wait(80);
    expect(Math.abs(design.getBoundingClientRect().left - midX)).toBeLessThan(
      1.5,
    );
  });
});
