import { closestEdge, edgeAutoScroll } from '@mmstack/dnd/plugins';

/** A div whose layout rect we control (happy-dom returns zeros otherwise). */
function rectEl(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 100, left: 0, right: 100, ...rect }) as DOMRect;
  return el;
}

describe('closestEdge (first-party hitbox plugin)', () => {
  it('attaches the nearest allowed edge by perpendicular distance', () => {
    const el = rectEl({ top: 0, bottom: 100, left: 0, right: 100 });

    const near = (
      x: number,
      y: number,
      edges: ('top' | 'bottom' | 'left' | 'right')[],
    ) =>
      closestEdge.extractClosestEdge(
        closestEdge.attachClosestEdge(
          {},
          { element: el, input: { clientX: x, clientY: y }, allowedEdges: edges },
        ),
      );

    expect(near(50, 5, ['top', 'bottom'])).toBe('top');
    expect(near(50, 95, ['top', 'bottom'])).toBe('bottom');
    expect(near(5, 50, ['left', 'right'])).toBe('left');
    expect(near(95, 50, ['left', 'right'])).toBe('right');
  });

  it('only considers allowed edges (ignores a closer disallowed one)', () => {
    const el = rectEl({ top: 0, bottom: 100, left: 0, right: 100 });
    const edge = closestEdge.extractClosestEdge(
      closestEdge.attachClosestEdge(
        {},
        { element: el, input: { clientX: 50, clientY: 1 }, allowedEdges: ['bottom'] },
      ),
    );
    expect(edge).toBe('bottom');
  });

  it('extractClosestEdge returns null when nothing was attached', () => {
    expect(closestEdge.extractClosestEdge({})).toBeNull();
  });
});

describe('edgeAutoScroll (first-party auto-scroll plugin)', () => {
  // Drive rAF manually so we can step frames with explicit timestamps.
  let frames: FrameRequestCallback[] = [];
  const frame = (ts: number) => frames.shift()?.(ts);

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    // scrollParentOf reads getComputedStyle(node).overflow{X,Y} — reflect inline style.
    vi.stubGlobal(
      'getComputedStyle',
      (node: HTMLElement) => node.style as unknown as CSSStyleDeclaration,
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A self-scrolling container (`viewport`px tall, 1000px content) — element IS its own scroll parent. */
  function scroller(scrollTop = 0, viewport = 200): HTMLElement {
    const el = document.createElement('div');
    el.style.overflowY = 'auto';
    let top = scrollTop;
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (v: number) => (top = v),
      configurable: true,
    });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: viewport, configurable: true });
    el.getBoundingClientRect = () =>
      ({ top: 0, bottom: viewport, left: 0, right: 100 }) as DOMRect;
    return el;
  }

  it('scrolls toward the neared edge — and works when the element is its own scroll container', () => {
    const el = scroller();
    const deltas: number[] = [];
    const stop = edgeAutoScroll({
      element: el, // self-scrolling (scrollParentOf resolves to el itself)
      axis: 'y',
      pointer: () => ({ x: 50, y: 195 }), // within 48px of the bottom (hi = 200)
      onScroll: (d: number) => deltas.push(d),
    });
    frame(1000); // first engaged frame — ease-in is 0 here
    frame(1400); // 400ms later — eased in
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(deltas.at(-1)).toBeGreaterThan(0);
    stop();
  });

  it('does not scroll when the pointer is away from every edge', () => {
    const el = scroller();
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 100 }), // middle
    });
    frame(1000);
    frame(1400);
    expect(el.scrollTop).toBe(0);
    stop();
  });

  it('respects the scroll limit — no scroll when already at the end', () => {
    const el = scroller(800); // 800 + clientHeight 200 = 1000 = scrollHeight → maxed
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 199 }), // hard against the bottom
    });
    frame(1000);
    frame(1400);
    expect(el.scrollTop).toBe(800); // can-scroll check blocks it
    stop();
  });

  it('eases in — the first engaged frame barely moves, later frames move more', () => {
    const el = scroller();
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 200 }), // full ramp at the edge
    });
    frame(1000); // engage; dilation 0 → ~no movement
    const afterFirst = el.scrollTop;
    frame(1100); // 100ms in → dilation 0.25
    frame(1500); // 500ms in → dilation capped at 1
    const afterEase = el.scrollTop - afterFirst;
    expect(afterFirst).toBeLessThan(1); // ease-in: first frame ≈ 0
    expect(afterEase).toBeGreaterThan(afterFirst);
    stop();
  });

  it('is frame-rate independent — halving the frame interval does not ~double the scroll', () => {
    const run = (interval: number) => {
      const el = scroller();
      const stop = edgeAutoScroll({
        element: el,
        axis: 'y',
        pointer: () => ({ x: 50, y: 200 }),
      });
      for (let t = 1000; t <= 2400; t += interval) frame(t); // 1.4s window
      stop();
      return el.scrollTop;
    };
    const at60 = run(1000 / 60);
    const at120 = run(1000 / 120);
    // the old px/frame bug would make 120Hz ~2x; time-based keeps them close.
    expect(at120).toBeGreaterThan(at60 * 0.7);
    expect(at120).toBeLessThan(at60 * 1.4);
  });

  it('uses a proportional engage band — smaller container, smaller band', () => {
    // viewport 100 → band = min(0.25 * 100, 48) = 25px, so the edge zone is [75, 100].
    const el = scroller(0, 100);
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 70 }), // inside a flat-48 band, OUTSIDE the 25px band
    });
    frame(1000);
    frame(1400);
    expect(el.scrollTop).toBe(0); // proportional band didn't engage at y=70
    stop();
  });

  it('maxSpeedAt: reaches full speed before the true edge (lower → faster sooner)', () => {
    const at = (maxSpeedAt: number) => {
      const el = scroller(); // band 48; pointer 30px in (y=170) → below the 48 edge
      const stop = edgeAutoScroll({
        element: el,
        axis: 'y',
        pointer: () => ({ x: 50, y: 170 }),
        maxSpeedAt,
      });
      frame(1000);
      frame(1400);
      frame(1800);
      stop();
      return el.scrollTop;
    };
    // 30/48 ≈ 0.63 ramp at maxSpeedAt:1; 30/(48·0.5) clamps to 1 at maxSpeedAt:0.5 → more scroll
    expect(at(0.5)).toBeGreaterThan(at(1));
  });

  it('no-ops (returns a cleanup) when called without a pointer context', () => {
    const stop = edgeAutoScroll({ element: rectEl({}) });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('cancels its rAF loop on stop (no leaked frame after teardown)', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const el = scroller();
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 50 }),
    });
    frame(1000); // one tick → re-arms the next rAF (loop is live)
    stop();
    expect(cancel).toHaveBeenCalledTimes(1); // the pending frame is cancelled
    expect(typeof cancel.mock.calls[0][0]).toBe('number'); // ...by its handle
  });
});
