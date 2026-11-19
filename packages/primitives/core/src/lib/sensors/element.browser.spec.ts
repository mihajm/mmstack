import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { cdp, server } from 'vitest/browser';
import { elementSize } from './element-size';
import { elementVisibility } from './element-visibility';

const chromium = server.browser === 'chromium';
type Cdp = { send(method: string, params?: object): Promise<unknown> };

function box(style: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('style', style);
  document.body.appendChild(el);
  return el;
}

async function frames(n = 3) {
  for (let i = 0; i < n; i++) {
    TestBed.tick();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  }
  TestBed.tick();
}

async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await frames(1);
}

const injector = () => TestBed.inject(Injector);
const padded =
  'box-sizing: content-box; width: 100px; height: 40px; padding: 10px; border: 5px solid black;';

afterEach(() => {
  document.body.replaceChildren();
});

describe('elementSize in a real layout', () => {
  it('reports the border box by default and the content box on request, and follows a resize', async () => {
    const el = box(padded);
    const border = elementSize(el, { injector: injector() });
    const content = elementSize(el, {
      box: 'content-box',
      injector: injector(),
    });
    await frames();
    expect([border(), content()]).toEqual([
      { width: 130, height: 70 },
      { width: 100, height: 40 },
    ]);

    el.style.width = '150px';
    await until(() => border()?.width === 180);
    expect([border(), content()]).toEqual([
      { width: 180, height: 70 },
      { width: 150, height: 40 },
    ]);
  });

  it('stops reporting when the target signal goes null', async () => {
    const el = box(padded);
    const target = signal<Element | null>(el);
    const size = elementSize(target, { injector: injector() });
    await frames();
    expect(size()).toEqual({ width: 130, height: 70 });

    target.set(null);
    await frames();
    expect(size()).toBeUndefined();
    el.style.width = '10px';
    await frames();
    expect(size()).toBeUndefined();
  });

  it.each(['vertical-rl', 'vertical-lr'])(
    'reports physical width and height under writing-mode %s, before and after a resize',
    async (mode) => {
      const el = box(
        `writing-mode: ${mode}; width: 100px; height: 300px; padding: 10px; box-sizing: content-box;`,
      );
      const border = elementSize(el, { injector: injector() });
      const content = elementSize(el, {
        box: 'content-box',
        injector: injector(),
      });
      expect(border()).toEqual({ width: 120, height: 320 });
      await frames();
      expect([border(), content()]).toEqual([
        { width: 120, height: 320 },
        { width: 100, height: 300 },
      ]);

      el.style.height = '200px';
      await until(() => border()?.height !== 320);
      expect([border(), content()]).toEqual([
        { width: 120, height: 220 },
        { width: 100, height: 200 },
      ]);
    },
  );

  it('platform: under a vertical writing mode contentBoxSize is logical and contentRect is physical', async () => {
    const el = box('writing-mode: vertical-rl; width: 100px; height: 300px;');
    const entry = await new Promise<ResizeObserverEntry>((resolve) => {
      const ro = new ResizeObserver(([e]) => {
        ro.disconnect();
        resolve(e);
      });
      ro.observe(el, { box: 'content-box' });
    });
    expect([
      entry.contentBoxSize[0].inlineSize,
      entry.contentBoxSize[0].blockSize,
      entry.contentRect.width,
      entry.contentRect.height,
    ]).toEqual([300, 100, 100, 300]);
  });

  it.runIf(chromium)(
    'reports device pixels for device-pixel-content-box at a device scale factor of 2',
    async () => {
      const session = cdp() as unknown as Cdp;
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 2,
        mobile: false,
      });
      try {
        await frames();
        expect(devicePixelRatio).toBe(2);
        const el = box('width: 100px; height: 30px; padding: 4px;');
        const size = elementSize(el, {
          box: 'device-pixel-content-box',
          injector: injector(),
        });
        await until(() => size()?.width === 200);
        expect(size()).toEqual({ width: 200, height: 60 });
      } finally {
        await session.send('Emulation.clearDeviceMetricsOverride');
      }
    },
  );
});

describe('elementVisibility in a real layout', () => {
  it('flips as the target scrolls into and out of view', async () => {
    const scroller = box('height: 200px; overflow: auto;');
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    const target = document.createElement('div');
    target.style.height = '50px';
    scroller.append(spacer, target, spacer.cloneNode());

    const vis = elementVisibility(target, {
      root: scroller,
      injector: injector(),
    });
    await frames();
    expect(vis.visible()).toBe(false);

    scroller.scrollTop = 900;
    await until(() => vis.visible());
    expect(vis.visible()).toBe(true);

    scroller.scrollTop = 0;
    await until(() => !vis.visible());
    expect(vis.visible()).toBe(false);
  });

  it('steps intersectionRatio across thresholds while still intersecting', async () => {
    const scroller = box('height: 100px; overflow: auto;');
    const spacer = document.createElement('div');
    spacer.style.height = '100px';
    const target = document.createElement('div');
    target.style.height = '100px';
    scroller.append(spacer, target, spacer.cloneNode());

    const vis = elementVisibility(target, {
      root: scroller,
      threshold: [0, 0.5, 1],
      injector: injector(),
    });
    await frames();
    expect(vis()?.intersectionRatio ?? 0).toBe(0);

    scroller.scrollTop = 60;
    await until(() => (vis()?.intersectionRatio ?? 0) >= 0.5);
    expect(vis()?.intersectionRatio).toBeCloseTo(0.6, 1);

    scroller.scrollTop = 100;
    await until(() => vis()?.intersectionRatio === 1);
    expect([vis.visible(), vis()?.intersectionRatio]).toEqual([true, 1]);
  });
});
