import { suppressNativePinch, zoomWheelDelta } from './wheel';

function wheel(
  deltaY: number,
  opts: { deltaMode?: number; ctrlKey?: boolean } = {},
): WheelEvent {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as Event &
    Record<string, unknown>;
  e['deltaY'] = deltaY;
  e['deltaMode'] = opts.deltaMode ?? 0;
  e['ctrlKey'] = opts.ctrlKey ?? false;
  return e as unknown as WheelEvent;
}

describe('zoomWheelDelta', () => {
  it('passes pixel-mode deltas through unchanged', () => {
    expect(zoomWheelDelta(wheel(-100))).toBe(-100);
    expect(zoomWheelDelta(wheel(40))).toBe(40);
  });

  it('scales line-mode deltas to pixel magnitude', () => {
    expect(zoomWheelDelta(wheel(-3, { deltaMode: 1 }))).toBe(-75);
  });

  it('scales page-mode deltas to pixel magnitude', () => {
    expect(zoomWheelDelta(wheel(1, { deltaMode: 2 }))).toBe(500);
  });

  it('boosts a ctrl-wheel — trackpad pinch — tenfold', () => {
    expect(zoomWheelDelta(wheel(-10, { ctrlKey: true }))).toBe(-100);
  });
});

describe('suppressNativePinch', () => {
  it('cancels Safari gesture events until torn down', () => {
    const el = document.createElement('div');
    const release = suppressNativePinch(el);

    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const e = new Event(type, { cancelable: true });
      el.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }

    release();
    const after = new Event('gesturestart', { cancelable: true });
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
