import { userEvent } from 'vitest/browser';

import { at, drag, mount, resetPointer, until } from '../testing/browser';
import { WrapGridExample } from '../testing/fixtures/wrap-grid';

let root: HTMLElement;
const tiles = (name = 'gallery') =>
  Array.from(root.querySelectorAll<HTMLElement>(`ul[data-list="${name}"] li`));
const order = () => tiles().map((t) => t.innerText.trim());

beforeEach(async () => {
  root = (await mount(WrapGridExample)).nativeElement as HTMLElement;
  expect(tiles().length).toBeGreaterThan(0);
});
afterEach(resetPointer);

describe('wrap grid: 2D sortable', () => {
  it('reorders across a row boundary in reading order', async () => {
    expect(order().slice(0, 6)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    await drag(tiles()[0], [tiles()[4]]);
    await until(() =>
      expect(order()).toEqual([
        'T2',
        'T3',
        'T4',
        'T5',
        'T1',
        'T6',
        'T7',
        'T8',
        'T9',
      ]),
    );
  });

  it('a drag within the same slot commits nothing', async () => {
    const before = order();
    await drag(tiles()[0], at(tiles()[0], { fx: 0.6, fy: 0.6 }));
    await until(() => expect(order()).toEqual(before));
  });

  it('keyboard: ArrowRight steps, ArrowDown jumps a row', async () => {
    tiles()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    await until(() =>
      expect(order()).toEqual([
        'T2',
        'T1',
        'T3',
        'T4',
        'T5',
        'T6',
        'T7',
        'T8',
        'T9',
      ]),
    );

    // Down lands on the nearest tile in the row below, wherever the wrap broke the row
    const t1 = () =>
      tiles().find((t) => t.innerText.trim() === 'T1') as HTMLElement;
    const before = t1().getBoundingClientRect();
    t1().focus();
    await userEvent.keyboard('{ArrowDown}');
    await until(() => {
      const now = t1().getBoundingClientRect();
      expect(now.top).toBeGreaterThan(before.top + 40);
      expect(Math.abs(now.left - before.left)).toBeLessThan(60);
    });
  });

  it('moves between the tray list and the wrap grid (one group)', async () => {
    expect(tiles('mini')).toHaveLength(5);
    expect(tiles('tray')).toHaveLength(2);

    await drag(tiles('tray')[0], tiles('mini')[4], { settle: 60 });
    await until(() => {
      expect(tiles('mini')).toHaveLength(6);
      expect(tiles('tray')).toHaveLength(1);
    });

    await drag(tiles('mini')[0], tiles('tray')[0], { settle: 60 });
    await until(() => {
      expect(tiles('mini')).toHaveLength(5);
      expect(tiles('tray')).toHaveLength(2);
    });
  });
});
