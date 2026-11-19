import {
  byText,
  countText,
  dispatchDrag,
  mount,
  nativeDrag,
  until,
} from '../testing/browser';
import { CoreExample } from '../testing/fixtures/core';

const column = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll<HTMLElement>('section.col')).find(
    (s) => s.querySelector('header')?.textContent?.trim() === name,
  ) as HTMLElement;

async function setup() {
  const fixture = await mount(CoreExample);
  return fixture.nativeElement as HTMLElement;
}

describe('core: draggable + dropTarget + monitor', () => {
  it('drags a card into another column', async () => {
    const root = await setup();
    const card = byText(root, '.card', 'Design landing page');
    await nativeDrag(card, column(root, 'done'));

    await until(() => {
      expect(
        countText(column(root, 'done'), '.card', 'Design landing page'),
      ).toBe(1);
      expect(
        countText(column(root, 'todo'), '.card', 'Design landing page'),
      ).toBe(0);
    });
  });

  it('reflects the active drag in the monitor banner, then clears on drop', async () => {
    const root = await setup();
    const dt = new DataTransfer();
    const card = byText(root, '.card', 'Write copy');
    const done = column(root, 'done');
    const status = root.querySelector('.status') as HTMLElement;

    dispatchDrag(card, 'dragstart', dt);
    await until(() => expect(status.textContent).toContain('Write copy'));

    dispatchDrag(done, 'dragenter', dt);
    dispatchDrag(done, 'drop', dt);
    dispatchDrag(card, 'dragend', dt);

    await until(() => {
      expect(status.textContent).not.toContain('Dragging');
      expect(countText(column(root, 'done'), '.card', 'Write copy')).toBe(1);
    });
  });

  it('only the innermost accepting zone receives the drop', async () => {
    const root = await setup();
    const card = byText(root, '.card', 'Set up analytics');
    await nativeDrag(card, column(root, 'doing'));
    await until(() => {
      expect(
        countText(column(root, 'doing'), '.card', 'Set up analytics'),
      ).toBe(1);
      expect(countText(column(root, 'todo'), '.card', 'Set up analytics')).toBe(
        0,
      );
    });
  });
});
