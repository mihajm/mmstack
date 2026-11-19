import {
  cdpTouch,
  center,
  down,
  emulateTouch,
  labels,
  mount,
  moveTo,
  resetPointer,
  until,
  up,
  wait,
  notChromium,
} from '../testing/browser';
import { TouchDndExample } from '../testing/fixtures/touch-dnd';

// Touch behavior of pointer lists: axis-aware `touch-action` and the opt-in
// long-press. Real touch (native scrolling, touch-action) goes through CDP, so
// those runs are Chromium-only; the long-press gate itself runs on synthetic
// touch PointerEvents.

let root: HTMLElement;
const list = (name: string) =>
  root.querySelector(`ul[data-list="${name}"]`) as HTMLElement;
const items = (name: string) =>
  Array.from(list(name).querySelectorAll<HTMLElement>('li'));
const order = (name: string) => labels(list(name), 'li');
const box = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { ...center(el), h: r.height };
};

beforeEach(async () => {
  root = (await mount(TouchDndExample, { width: 420, height: 700 }))
    .nativeElement as HTMLElement;
  expect(items('long-press')).toHaveLength(4);
  await wait(100);
});
afterEach(resetPointer);

describe('touch-action', () => {
  it('a vertical list without a handle leaves horizontal panning to the page; long-press lists use manipulation', () => {
    const ta = (name: string) =>
      items(name).map((e) => getComputedStyle(e).touchAction);
    expect(ta('axis')).toEqual(Array(4).fill('pan-x'));
    expect(ta('long-press')).toEqual(Array(4).fill('manipulation'));
  });
});

function fire(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  );
}

describe('long-press gate (synthetic touch)', () => {
  it('a touch that rests for the delay, then moves, reorders', async () => {
    const first = items('long-press')[0];
    const a = box(first);
    const b = box(items('long-press')[2]);

    fire(first, 'pointerdown', a.x, a.y);
    await wait(150);
    fire(first, 'pointermove', a.x + 3, a.y + 4);
    // mid-delay: no drag yet, though 5px is the activation threshold
    await wait(16);
    expect(list('long-press').getAttribute('data-active')).toBe('');
    await wait(250);
    for (let i = 1; i <= 8; i++) {
      fire(first, 'pointermove', a.x, a.y + ((b.y + b.h / 2 - a.y) * i) / 8);
      await wait(16);
    }
    await until(() =>
      expect(list('long-press').getAttribute('data-active')).toBe('1'),
    );
    fire(first, 'pointerup', a.x, b.y + b.h / 2);
    await until(() =>
      expect(order('long-press')).toEqual([
        'Hold Two',
        'Hold Three',
        'Hold One',
        'Hold Four',
      ]),
    );
  });

  it('a touch that moves before the delay never drags', async () => {
    const first = items('long-press')[0];
    const a = box(first);
    fire(first, 'pointerdown', a.x, a.y);
    fire(first, 'pointermove', a.x, a.y + 30);
    await wait(400);
    for (let i = 1; i <= 6; i++) {
      fire(first, 'pointermove', a.x, a.y + 30 + i * 20);
      await wait(16);
    }
    expect(list('long-press').getAttribute('data-active')).toBe('');
    fire(first, 'pointerup', a.x, a.y + 150);
    await wait(50);
    expect(order('long-press')).toEqual([
      'Hold One',
      'Hold Two',
      'Hold Three',
      'Hold Four',
    ]);
  });

  it('the mouse is never delayed', async () => {
    const a = box(items('long-press')[0]);
    const b = box(items('long-press')[2]);
    await moveTo(a);
    await down();
    await moveTo({ x: a.x, y: a.y + 10 }, 2);
    await until(() =>
      expect(list('long-press').getAttribute('data-active')).toBe('1'),
    );
    await moveTo({ x: a.x, y: b.y + b.h / 2 }, 10);
    await up();
    await until(() =>
      expect(order('long-press')).toEqual([
        'Hold Two',
        'Hold Three',
        'Hold One',
        'Hold Four',
      ]),
    );
  });
});

describe.skipIf(notChromium)('real touch (Chromium, CDP)', () => {
  // start mid-page so a stray scroll in either direction shows up
  beforeAll(() => emulateTouch(true));
  afterAll(() => emulateTouch(false));
  // a swipe leaves a fling running; a touch that lands on it is uncancelable
  afterEach(async () => {
    let y = NaN;
    await until(() => {
      const now = window.scrollY;
      const still = now === y;
      y = now;
      expect(still).toBe(true);
    }, 3000);
  });
  beforeEach(async () => {
    window.scrollTo(0, 120);
    await until(() => expect(window.scrollY).toBe(120));
  });

  it('a vertical list drags on touch and the page does not scroll mid-drag, even with a sideways drift', async () => {
    const a = box(items('axis')[0]);
    const b = box(items('axis')[2]);
    const t = cdpTouch();
    const before = window.scrollY;
    await t.start(a);
    await t.glide(a, { x: a.x + 12, y: b.y + b.h / 2 });
    expect(window.scrollY).toBe(before);
    await t.end();
    await until(() =>
      expect(order('axis')).toEqual([
        'Axis Two',
        'Axis Three',
        'Axis One',
        'Axis Four',
      ]),
    );
    expect(window.scrollY).toBe(before);
  });

  it('long-press: a quick swipe over the list scrolls the page and starts no drag', async () => {
    const a = box(items('long-press')[0]);
    const t = cdpTouch();
    const before = window.scrollY;
    await t.start(a);
    await t.glide(a, { x: a.x, y: a.y - 200 });
    await t.end();
    await until(() => expect(window.scrollY).toBeGreaterThan(before + 50));
    expect(list('long-press').getAttribute('data-active')).toBe('');
    expect(order('long-press')).toEqual([
      'Hold One',
      'Hold Two',
      'Hold Three',
      'Hold Four',
    ]);
  });

  it('long-press: hold, then drag; the page stays put for the whole drag', async () => {
    const a = box(items('long-press')[0]);
    const b = box(items('long-press')[2]);
    const t = cdpTouch();
    const before = window.scrollY;
    await t.start(a);
    await wait(400);
    await t.glide(a, { x: a.x, y: b.y + b.h / 2 });
    await until(() =>
      expect(list('long-press').getAttribute('data-active')).toBe('1'),
    );
    expect(window.scrollY).toBe(before);
    await t.end();
    await until(() =>
      expect(order('long-press')).toEqual([
        'Hold Two',
        'Hold Three',
        'Hold One',
        'Hold Four',
      ]),
    );
    expect(window.scrollY).toBe(before);
  });
});
