import { userEvent } from 'vitest/browser';

import {
  at,
  byText,
  center,
  down,
  drag,
  mount,
  moveTo,
  perfCounters,
  resetPointer,
  until,
  up,
  wait,
  notChromium,
} from '../testing/browser';
import { PlacementGridExample } from '../testing/fixtures/placement-grid';

let root: HTMLElement;
const grid = () => root.querySelector('[data-grid="dashboard"]') as HTMLElement;
const widget = (label: string) => byText(grid(), '.widget', label);
const hasWidget = (label: string) =>
  Array.from(grid().querySelectorAll('.widget')).some((w) =>
    w.textContent?.includes(label),
  );
const tray = () =>
  Array.from(
    root.querySelectorAll<HTMLElement>('ul[data-list="widget-tray"] li'),
  );

function cellOf(label: string) {
  const g = grid().getBoundingClientRect();
  const b = widget(label).getBoundingClientRect();
  // 12 cols, 8px gap, 56px rows (the demo config)
  const unit = (g.width - 8 * 11) / 12;
  return {
    x: Math.round((b.left - g.left) / (unit + 8)),
    y: Math.round((b.top - g.top) / (56 + 8)),
    w: Math.round((b.width + 8) / (unit + 8)),
    h: Math.round((b.height + 8) / (56 + 8)),
  };
}

beforeEach(async () => {
  root = (await mount(PlacementGridExample)).nativeElement as HTMLElement;
  expect(hasWidget('Chart')).toBe(true);
});
afterEach(resetPointer);

describe('placement grid: spanning dashboard', () => {
  it('dragging a widget reflows neighbours and commits on release', async () => {
    expect(cellOf('KPIs')).toMatchObject({ x: 6, y: 0 });
    await drag(widget('KPIs'), [at(widget('Chart'), { fx: 0.1, fy: 0.3 })], {
      settle: 80,
    });
    await until(() => expect(cellOf('KPIs').x).toBeLessThan(3));
    const chart = cellOf('Chart');
    const kpis = cellOf('KPIs');
    expect(
      kpis.y + kpis.h <= chart.y ||
        chart.y + chart.h <= kpis.y ||
        kpis.x + kpis.w <= chart.x ||
        chart.x + chart.w <= kpis.x,
    ).toBe(true);
  });

  it('resize by the corner grip changes spans in whole cells', async () => {
    const before = cellOf('KPIs');
    const start = center(widget('KPIs').querySelector('.grip') as HTMLElement);
    await drag(start, { x: start.x + 120, y: start.y + 60 }, { settle: 80 });
    const after = cellOf('KPIs');
    expect(after.w).toBeGreaterThan(before.w);
    expect(Number.isInteger(after.w)).toBe(true);
  });

  it('keyboard: arrows move a cell, Shift+arrows resize', async () => {
    const before = cellOf('KPIs');
    widget('KPIs').focus();
    await userEvent.keyboard('{ArrowLeft}');
    await until(() => expect(cellOf('KPIs').x).toBe(before.x - 1));
    widget('KPIs').focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await until(() => expect(cellOf('KPIs').w).toBe(before.w + 1));
  });

  it('a grid widget over the tray morphs to a row preview and drops in', async () => {
    expect(tray()).toHaveLength(2);
    await drag(widget('Feed'), tray()[0], { release: false, settle: 80 });
    await until(() =>
      expect(root.querySelectorAll('.widget.as-row')).toHaveLength(1),
    );
    await up();
    await until(() => {
      expect(tray()).toHaveLength(3);
      expect(
        tray().filter((t) => t.textContent?.includes('Feed')),
      ).toHaveLength(1);
      expect(hasWidget('Feed')).toBe(false);
    });
  });

  it('a tray card drops into the grid at the pointed cell', async () => {
    expect(tray()).toHaveLength(2);
    const g = grid().getBoundingClientRect();
    await drag(
      tray()[0],
      { x: g.left + g.width * 0.4, y: g.top + g.height * 0.7 },
      { settle: 80, release: false },
    );
    await until(() =>
      expect(grid().querySelector('.target-cell')).not.toBeNull(),
    );
    await up();
    await until(() => {
      expect(tray()).toHaveLength(1);
      expect(hasWidget('Notes')).toBe(true);
    });
  });

  it('a move released outside the grid cancels; re-entering first commits', async () => {
    const g = grid().getBoundingClientRect();
    const before = { chart: cellOf('Chart'), kpis: cellOf('KPIs') };
    const k = widget('KPIs').getBoundingClientRect();
    const overKpis = { x: k.left + 20, y: k.top + 20 };
    const farRight = { x: g.right + 160, y: g.top + 40 };
    const farBelow = { x: g.left + g.width / 2, y: g.bottom + 600 };

    for (const out of [farRight, farBelow]) {
      await drag(widget('Chart'), [overKpis, out], {
        settle: 80,
        release: false,
      });
      await until(() => expect(cellOf('KPIs')).toEqual(before.kpis));
      await up();
      await wait(250);
      expect(cellOf('Chart')).toEqual(before.chart);
      expect(cellOf('KPIs')).toEqual(before.kpis);
    }

    await drag(widget('Chart'), [farRight, overKpis], { settle: 80 });
    await until(() => expect(cellOf('Chart').x).not.toBe(before.chart.x));
  });

  it('compact none: valid cells light up and occupied cells reject', async () => {
    const masked = root.querySelector('[data-grid="masked"]') as HTMLElement;
    const a = byText(masked, '.widget', 'A');
    const b = byText(masked, '.widget', 'B');
    const bBox = b.getBoundingClientRect();
    await drag(
      a,
      { x: bBox.left + 10, y: bBox.top + 10 },
      { release: false, settle: 60 },
    );
    await until(() => {
      expect(masked.querySelectorAll('.mask-cell').length).toBeGreaterThan(0);
      expect(masked.querySelector('.target-cell')).not.toBeNull();
    });
    await up();
    // dropped over B (occupied): rests at the last valid cell along the path
    await until(() =>
      expect(a.getBoundingClientRect().right).toBeLessThanOrEqual(
        b.getBoundingClientRect().left + 1,
      ),
    );
  });
});

describe.skipIf(notChromium)(
  'placement grid: perf guard (Chromium, CDP)',
  () => {
    it('a grid drag is transform-only between cell crossings', async () => {
      const read = await perfCounters();
      const start = center(widget('Feed'));
      await moveTo(start);
      await down();
      await moveTo({ x: start.x, y: start.y + 10 });
      const before = await read();
      for (let i = 0; i < 60; i++)
        await moveTo({ x: start.x + (i % 8), y: start.y + 10 + (i % 6) });
      const after = await read();
      await up();
      expect(after.layout - before.layout).toBeLessThan(10);
    });
  },
);
