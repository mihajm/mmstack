import {
  byText,
  drag,
  labels,
  mount,
  resetPointer,
  until,
  up,
} from '../testing/browser';
import { PointerEngineExample } from '../testing/fixtures/pointer-engine';

let root: HTMLElement;
const zone = (id: string) =>
  root.querySelector(`[data-zone="${id}"]`) as HTMLElement;
const chipsIn = (id: string) => labels(root, `[data-zone="${id}"] .chip`);

beforeEach(async () => {
  root = (await mount(PointerEngineExample)).nativeElement as HTMLElement;
  expect(chipsIn('b')).toContain('Three');
});
afterEach(resetPointer);

describe('pointer engine with real elementsFromPoint', () => {
  it('drags a chip from bucket A into bucket B', async () => {
    const r = zone('b').getBoundingClientRect();
    await drag(
      byText(zone('a'), '.chip', 'One'),
      { x: r.left + r.width / 2, y: r.bottom - 12 },
      { steps: 20, settle: 60 },
    );
    await until(() => {
      expect(chipsIn('b')).toContain('One');
      expect(chipsIn('a')).not.toContain('One');
    });
  });

  it('highlights the hovered drop zone while dragging', async () => {
    const a = zone('a');
    const r = a.getBoundingClientRect();
    let overMidDrag = false;
    await drag(
      byText(zone('b'), '.chip', 'Three'),
      [
        { x: r.left + r.width / 2, y: r.top + r.height / 2 - 4 },
        { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      ],
      {
        steps: 16,
        settle: 40,
        onWaypoint: (i) => {
          if (i === 1) overMidDrag = a.classList.contains('over');
        },
      },
    );
    expect(overMidDrag).toBe(true);
    await until(() => expect(chipsIn('a')).toContain('Three'));
  });

  it('resolves the live closest edge from the pointer over an edge zone', async () => {
    const edge = zone('edge');
    const r = edge.getBoundingClientRect();
    const upper = { x: r.left + r.width / 2, y: r.top + r.height * 0.15 };
    const lower = { x: r.left + r.width / 2, y: r.top + r.height * 0.85 };
    const seen: (string | null)[] = [];

    await drag(byText(zone('a'), '.chip', 'One'), [upper, lower, upper], {
      steps: 12,
      settle: 40,
      release: false,
      onWaypoint: async () => {
        await until(() =>
          expect(edge.getAttribute('data-edge')).not.toBeNull(),
        );
        seen.push(edge.getAttribute('data-edge'));
      },
    });
    expect(seen).toEqual(['top', 'bottom', 'top']);
    await up();

    const log = root.querySelector('[data-testid="edge-log"]') as HTMLElement;
    await until(() => expect(log.textContent?.trim()).toBe('One:top'));
    await until(() => expect(edge.getAttribute('data-edge')).toBeNull());
  });
});
