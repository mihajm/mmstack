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
          {
            element: el,
            input: { clientX: x, clientY: y },
            allowedEdges: edges,
          },
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
        {
          element: el,
          input: { clientX: 50, clientY: 1 },
          allowedEdges: ['bottom'],
        },
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
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    Object.defineProperty(el, 'scrollHeight', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', {
      value: viewport,
      configurable: true,
    });
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
      frames = [];
      const el = scroller();
      const stop = edgeAutoScroll({
        element: el,
        axis: 'y',
        pointer: () => ({ x: 50, y: 200 }),
      });
      // a window short of the 800px scroll limit, so neither run saturates
      for (let t = 1000; t <= 1700; t += interval) frame(t);
      stop();
      return el.scrollTop;
    };
    const at60 = run(1000 / 60);
    const at120 = run(1000 / 120);
    expect(at60).toBeGreaterThan(100);
    expect(at60).toBeLessThan(800);
    // a px/frame step would make 120Hz ~2x; time-based keeps them close.
    expect(at120).toBeGreaterThan(at60 * 0.9);
    expect(at120).toBeLessThan(at60 * 1.15);
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
      frames = [];
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
    const half = at(0.5);
    const full = at(1);
    expect(full).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(full);
    // 18px into the 48px band: ramp 18/48 at maxSpeedAt 1, 18/24 at 0.5
    expect(full / half).toBeCloseTo(0.5, 6);
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

describe('edgeAutoScroll without a pointer context', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once in dev mode and never starts a frame loop', async () => {
    vi.resetModules();
    const { edgeAutoScroll: fresh } = await import('@mmstack/dnd/plugins');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    try {
      fresh({ element: document.createElement('div') })();
      fresh({ element: document.createElement('div') })();
      expect(raf).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('pointer');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('closestEdge: off-origin rects and edge dispatch', () => {
  const at = (
    x: number,
    y: number,
    edges: ('top' | 'bottom' | 'left' | 'right')[],
  ) =>
    closestEdge.extractClosestEdge(
      closestEdge.attachClosestEdge(
        {},
        {
          element: rectEl({ top: 200, bottom: 300, left: 200, right: 300 }),
          input: { clientX: x, clientY: y },
          allowedEdges: edges,
        },
      ),
    );

  it('measures each edge on its own axis, relative to the rect', () => {
    expect(at(200, 205, ['top', 'bottom'])).toBe('top');
    expect(at(200, 295, ['top', 'bottom'])).toBe('bottom');
    expect(at(250, 205, ['top', 'bottom'])).toBe('top');
    expect(at(205, 250, ['left', 'right'])).toBe('left');
  });
});

describe('edgeAutoScroll: scroll parent, axes and speed', () => {
  let frames: FrameRequestCallback[] = [];
  const frame = (ts: number) => frames.shift()?.(ts);
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal(
      'getComputedStyle',
      (node: HTMLElement) => node.style as unknown as CSSStyleDeclaration,
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  type Geo = {
    overflowX?: string;
    overflowY?: string;
    scroll?: { left?: number; top?: number };
    size?: { sw?: number; sh?: number; cw?: number; ch?: number };
    rect?: Partial<DOMRect>;
  };
  function box(g: Geo = {}, parent?: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    if (g.overflowX) el.style.overflowX = g.overflowX;
    if (g.overflowY) el.style.overflowY = g.overflowY;
    let left = g.scroll?.left ?? 0;
    let top = g.scroll?.top ?? 0;
    Object.defineProperty(el, 'scrollLeft', {
      get: () => left,
      set: (v) => {
        left = v;
      },
      configurable: true,
    });
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (v) => {
        top = v;
      },
      configurable: true,
    });
    const z = { sw: 200, sh: 200, cw: 200, ch: 200, ...g.size };
    Object.defineProperty(el, 'scrollWidth', {
      value: z.sw,
      configurable: true,
    });
    Object.defineProperty(el, 'scrollHeight', {
      value: z.sh,
      configurable: true,
    });
    Object.defineProperty(el, 'clientWidth', {
      value: z.cw,
      configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', {
      value: z.ch,
      configurable: true,
    });
    el.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, left: 0, right: 200, ...g.rect }) as DOMRect;
    parent?.appendChild(el);
    return el;
  }
  const yScroller = (top = 0, rect?: Partial<DOMRect>) =>
    box({ overflowY: 'auto', scroll: { top }, size: { sh: 1000 }, rect });
  const run = (
    element: HTMLElement,
    pointer: () => { x: number; y: number },
    extra: Record<string, unknown> = {},
    times = [1000, 1400],
  ) => {
    frames = [];
    const stop = edgeAutoScroll({ element, pointer, ...extra });
    for (const t of times) frame(t);
    stop();
  };

  it('scrolls on y by default', () => {
    const el = yScroller();
    run(el, () => ({ x: 50, y: 199 }));
    expect(el.scrollTop).toBeGreaterThan(0);
  });

  it('moves one full speed step per 60fps frame once eased in, capped on long frames', () => {
    const el = yScroller();
    frames = [];
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y: 200 }),
    });
    frame(1000);
    expect(el.scrollTop).toBe(0);
    frame(1400);
    expect(el.scrollTop).toBeCloseTo(16, 6);
    frame(1400 + 1000 / 60);
    expect(el.scrollTop).toBeCloseTo(32, 6);
    frame(2400);
    expect(el.scrollTop).toBeCloseTo(48, 6);
    stop();
  });

  it('eases in from each engagement', () => {
    let y = 100;
    const el = yScroller();
    frames = [];
    const stop = edgeAutoScroll({
      element: el,
      axis: 'y',
      pointer: () => ({ x: 50, y }),
    });
    frame(1000);
    frame(2000);
    y = 200;
    frame(2016);
    expect(el.scrollTop).toBeLessThan(0.5);
    frame(2116);
    expect(el.scrollTop).toBeCloseTo(4, 6);
    y = 100;
    frame(2200);
    const before = el.scrollTop;
    y = 200;
    frame(2216);
    expect(el.scrollTop - before).toBeLessThan(0.5);
    stop();
  });

  it('scrolls up near the top, slower on a partial ramp, reporting negative travel', () => {
    const deltas: number[] = [];
    const edge = yScroller(300);
    run(edge, () => ({ x: 50, y: 0 }), {
      onScroll: (d: number) => deltas.push(d),
    });
    expect(edge.scrollTop).toBeLessThan(300);
    expect(deltas.at(-1)).toBeLessThan(0);
    const partial = yScroller(300);
    run(partial, () => ({ x: 50, y: 40 }));
    expect(300 - partial.scrollTop).toBeGreaterThan(0);
    expect(300 - partial.scrollTop).toBeLessThan(300 - edge.scrollTop);
  });

  it('reports zero travel while nothing scrolls', () => {
    const deltas: number[] = [];
    const el = box({
      overflowY: 'auto',
      overflowX: 'auto',
      scroll: { top: 300, left: 300 },
      size: { sh: 1000, sw: 1000 },
    });
    run(el, () => ({ x: 100, y: 100 }), {
      onScroll: (d: number) => deltas.push(d),
    });
    run(el, () => ({ x: 100, y: 100 }), {
      axis: 'x',
      onScroll: (d: number) => deltas.push(d),
    });
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d === 0)).toBe(true);
  });

  it('measures the band from an off-origin container rect', () => {
    const up = yScroller(300, { top: 100, bottom: 200 });
    run(up, () => ({ x: 50, y: 110 }));
    expect(up.scrollTop).toBeLessThan(300);
    const down = yScroller(0, { top: 100, bottom: 200 });
    run(down, () => ({ x: 50, y: 170 }));
    expect(down.scrollTop).toBe(0);
  });

  it('scrolls a self-scrolling x container both ways, leaving y alone', () => {
    const g: Geo = {
      overflowX: 'auto',
      size: { sw: 1000 },
      rect: { left: 0, right: 200, top: 100, bottom: 300 },
    };
    const right = box(g);
    run(right, () => ({ x: 195, y: 200 }), { axis: 'x' });
    expect(right.scrollLeft).toBeGreaterThan(0);
    expect(right.scrollTop).toBe(0);
    const left = box({ ...g, scroll: { left: 300 } });
    run(left, () => ({ x: 5, y: 200 }), { axis: 'x' });
    expect(left.scrollLeft).toBeLessThan(300);
  });

  it('picks the nearest ancestor that really scrolls on the axis', () => {
    const outerY = yScroller();
    const skip = [
      box({ overflowY: 'auto', size: { sh: 200 } }, outerY),
      box({ size: { sh: 1000 } }, outerY),
    ];
    for (const inner of skip) {
      run(inner, () => ({ x: 50, y: 199 }));
      expect(inner.scrollTop).toBe(0);
    }
    expect(outerY.scrollTop).toBeGreaterThan(0);

    const scrollStyle = box({ overflowY: 'scroll', size: { sh: 1000 } });
    run(scrollStyle, () => ({ x: 50, y: 199 }));
    expect(scrollStyle.scrollTop).toBeGreaterThan(0);

    const outerX = box({ overflowX: 'auto', size: { sw: 1000 } });
    const innerX = box({ overflowX: 'auto', size: { sh: 1000 } }, outerX);
    run(innerX, () => ({ x: 199, y: 100 }), { axis: 'x' });
    expect(innerX.scrollLeft).toBe(0);
    expect(outerX.scrollLeft).toBeGreaterThan(0);
  });

  it('falls back to the page scroller, never the body, measuring against the window', () => {
    const page = document.documentElement;
    const body = document.body;
    const restore: (() => void)[] = [];
    const def = (o: object, k: string, v: PropertyDescriptor) => {
      Object.defineProperty(o, k, { configurable: true, ...v });
      restore.push(() => delete (o as Record<string, unknown>)[k]);
    };
    let pageTop = 0;
    let bodyTop = 0;
    def(page, 'scrollTop', {
      get: () => pageTop,
      set: (v) => {
        pageTop = v;
      },
    });
    def(page, 'scrollHeight', { value: 5000 });
    def(page, 'clientHeight', { value: window.innerHeight });
    def(body, 'scrollTop', {
      get: () => bodyTop,
      set: (v) => {
        bodyTop = v;
      },
    });
    def(body, 'scrollHeight', { value: 5000 });
    def(body, 'clientHeight', { value: 100 });
    body.style.overflowY = 'auto';
    const el = document.createElement('div');
    body.appendChild(el);
    try {
      run(el, () => ({ x: 10, y: window.innerHeight - 5 }));
      expect(pageTop).toBeGreaterThan(0);
      expect(bodyTop).toBe(0);
    } finally {
      el.remove();
      body.style.overflowY = '';
      for (const r of restore) r();
    }
  });

  it('a detached element falls back to the page without throwing', () => {
    const el = document.createElement('div');
    expect(() => run(el, () => ({ x: 10, y: 10 }))).not.toThrow();
  });
});

describe('edgeAutoScroll: app-shell layout', () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal(
      'getComputedStyle',
      (node: HTMLElement) => node.style as unknown as CSSStyleDeclaration,
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('scrolls the body when html clips and the body is the scroller', () => {
    const html = document.documentElement;
    const body = document.body;
    let bodyTop = 0;
    const keys = ['scrollTop', 'scrollHeight', 'clientHeight'] as const;
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => bodyTop,
      set: (v) => {
        bodyTop = v;
      },
    });
    Object.defineProperty(body, 'scrollHeight', {
      configurable: true,
      value: 5000,
    });
    Object.defineProperty(body, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    const rect = body.getBoundingClientRect;
    body.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 300 }) as DOMRect;
    html.style.overflowY = 'hidden';
    body.style.overflowY = 'auto';
    const el = document.createElement('div');
    body.appendChild(el);
    try {
      const stop = edgeAutoScroll({
        element: el,
        pointer: () => ({ x: 10, y: 399 }),
      });
      frames.shift()?.(1000);
      frames.shift()?.(1400);
      stop();
      expect(bodyTop).toBeGreaterThan(0);
    } finally {
      el.remove();
      html.style.overflowY = '';
      body.style.overflowY = '';
      body.getBoundingClientRect = rect;
      for (const k of keys)
        delete (body as unknown as Record<string, unknown>)[k];
    }
  });
});
