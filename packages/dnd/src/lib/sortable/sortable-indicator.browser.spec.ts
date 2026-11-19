import {
  byText,
  countText,
  mount,
  nativeDrag,
  texts,
  until,
} from '../testing/browser';
import { SortableIndicatorExample } from '../testing/fixtures/sortable-indicator';

// Native (indicator) engine under real HTML5 DnD. Items are drop targets, so
// crossing them fires `onDropTargetChange` and the session pointer advances
// even under Playwright's synthetic `dragTo`.

const list = (root: HTMLElement, name: string) =>
  root.querySelector(`ul[data-list="${name}"]`) as HTMLElement;

async function setup() {
  return (await mount(SortableIndicatorExample)).nativeElement as HTMLElement;
}

const translateOf = (kf: Keyframe | undefined) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
    String(kf?.['transform'] ?? ''),
  );
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

afterEach(() => {
  document.body.style.minHeight = '';
  window.scrollTo(0, 0);
});

describe('sortable indicator (native engine)', () => {
  it('reorders within a list (same-list, via per-item drop targets)', async () => {
    const root = await setup();
    const ind = list(root, 'ind');
    await nativeDrag(byText(ind, 'li', 'One'), byText(ind, 'li', 'Four'), {
      x: 12,
      y: 24,
    });

    await until(() => {
      const after = texts(ind, 'li');
      expect(after[0]).not.toBe('One');
      expect([...after].sort()).toEqual(['Four', 'One', 'Three', 'Two']);
    });
  });

  it('moves a row across lists (shared group)', async () => {
    const root = await setup();
    const todo = list(root, 'ind-todo');
    const doing = list(root, 'ind-doing');
    await nativeDrag(byText(todo, 'li', 'Build'), doing, { x: 12, y: 12 });

    await until(() => {
      expect(countText(doing, 'li', 'Build')).toBe(1);
      expect(countText(todo, 'li', 'Build')).toBe(0);
    });
  });

  it('inserts a mapped item from the palette', async () => {
    const root = await setup();
    const target = list(root, 'ind-insert');
    await nativeDrag(byText(root, '.chip', 'note'), target, { x: 12, y: 12 });

    await until(() => expect(countText(target, 'li', 'New note')).toBe(1));
    expect(countText(root, '.chip', 'note')).toBe(1);
  });

  it.each([
    ['at rest', 0],
    ['after the page scrolled since the last render', 40],
  ])(
    'the commit glide starts every moved row from where it sat before the drag (%s)',
    async (_, scroll) => {
      const root = await setup();
      const ind = list(root, 'ind');
      document.body.style.minHeight = '4000px';
      window.scrollTo(0, scroll);
      await until(() => expect(window.scrollY).toBe(scroll));
      const before = new Map(
        Array.from(ind.querySelectorAll('li'), (li) => [
          (li.textContent ?? '').trim(),
          li.offsetTop,
        ]),
      );

      await nativeDrag(byText(ind, 'li', 'One'), byText(ind, 'li', 'Four'), {
        x: 12,
        y: 24,
      });
      await until(() => expect(texts(ind, 'li')[0]).not.toBe('One'));

      const moved = Array.from(ind.querySelectorAll('li')).filter(
        (li) => before.get((li.textContent ?? '').trim()) !== li.offsetTop,
      );
      expect(moved.length).toBeGreaterThan(0);
      for (const li of moved) {
        const label = (li.textContent ?? '').trim();
        const anim = li
          .getAnimations()
          .find((a) => (a.effect as KeyframeEffect).getKeyframes().length);
        if (!anim) throw new Error(`no glide on ${label}`);
        anim.pause();
        const from = translateOf(
          (anim.effect as KeyframeEffect).getKeyframes()[0],
        );
        anim.cancel();
        const expected = (before.get(label) ?? NaN) - li.offsetTop;
        expect(Math.abs((from?.y ?? NaN) - expected), label).toBeLessThan(1);
      }
    },
  );
});
