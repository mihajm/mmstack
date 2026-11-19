import { page, userEvent } from 'vitest/browser';

import { center, drag, mount, resetPointer, until } from '../testing/browser';
import { CanvasStoreExample } from '../testing/fixtures/canvas-store';

let root: HTMLElement;
const q = (sel: string) => root.querySelector(sel) as HTMLElement;
const widget = (id: string) => q(`[data-widget="${id}"]`);
const left = (id: string) => widget(id).getBoundingClientRect().left;
const batchCount = () =>
  Number(q('[data-testid="batch-count"]').innerText.split(' ')[0]);
const click = (testId: string) =>
  userEvent.click(page.elementLocator(q(`[data-testid="${testId}"]`)));

beforeEach(async () => {
  root = (await mount(CanvasStoreExample)).nativeElement as HTMLElement;
  await until(() =>
    expect(root.querySelector('[data-mm-canvas-ready]')).not.toBeNull(),
  );
});
afterEach(resetPointer);

describe('canvas x store: gesture-grained ops', () => {
  it('one drag emits exactly one op batch; undo/redo restores frames', async () => {
    expect(batchCount()).toBe(0);
    const before = left('a');
    const c = center(widget('a'));
    await drag(widget('a'), { x: c.x + 100, y: c.y + 60 }, { settle: 80 });
    await until(() => expect(batchCount()).toBe(1));
    const moved = left('a');
    expect(moved).toBeGreaterThan(before + 60);

    const trace = q('[data-testid="trace"]').textContent;
    expect(trace).toContain('widgets.0.frame.x');
    expect(trace).toContain('widgets.0.frame.y');

    await click('undo');
    await until(() => expect(Math.abs(left('a') - before)).toBeLessThan(0.5));
    await click('redo');
    await until(() => expect(Math.abs(left('a') - moved)).toBeLessThan(0.5));
  });

  it('two drags = two undo steps, restored in order', async () => {
    const start = left('a');
    const c0 = center(widget('a'));
    await drag(widget('a'), { x: c0.x + 60, y: c0.y }, { settle: 60 });
    const mid = left('a');
    const c1 = center(widget('a'));
    await drag(widget('a'), { x: c1.x + 60, y: c1.y + 60 }, { settle: 60 });
    await until(() => expect(batchCount()).toBe(2));

    await click('undo');
    await until(() => expect(Math.abs(left('a') - mid)).toBeLessThan(0.5));
    await click('undo');
    await until(() => expect(Math.abs(left('a') - start)).toBeLessThan(0.5));
  });
});
