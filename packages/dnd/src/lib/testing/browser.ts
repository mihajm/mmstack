import { type Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge';
import { edgeAutoScroll } from '@mmstack/dnd/plugins';
import { cdp, page, server, userEvent } from 'vitest/browser';

import { provideDnd } from '../provide';

/**
 * Browser-mode drag harness. The test iframe sits at the page origin, so
 * viewport coords inside the test document are the coords the real mouse
 * takes. Each move is one real `pointermove`; `steps` interpolates between
 * waypoints the way Playwright's `mouse.move(..., { steps })` does.
 */
export type Point = { x: number; y: number };
export type Waypoint = Element | Point;

const isPoint = (w: Waypoint): w is Point =>
  typeof (w as Point).x === 'number' && typeof (w as Point).y === 'number';

export function center(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function at(el: Element, frac: { fx?: number; fy?: number }): Point {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width * (frac.fx ?? 0.5),
    y: r.top + r.height * (frac.fy ?? 0.5),
  };
}

export const resolvePoint = (w: Waypoint): Point =>
  isPoint(w) ? w : center(w);

let last: Point = { x: 0, y: 0 };

export async function moveTo(p: Point, steps = 1): Promise<void> {
  const from = last;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await userEvent.pointer({
      coords: {
        x: from.x + (p.x - from.x) * t,
        y: from.y + (p.y - from.y) * t,
      },
    });
  }
  last = p;
}

export async function down(): Promise<void> {
  await userEvent.pointer({ keys: '[MouseLeft>]', coords: last });
}

export async function up(): Promise<void> {
  await userEvent.pointer('[/MouseLeft]');
}

export const frame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

export async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type DragOptions = {
  steps?: number;
  settle?: number;
  onWaypoint?: (index: number, point: Point) => Promise<void> | void;
  release?: boolean;
};

/** Press at `from`, move through `waypoints` (resolved lazily, after earlier moves shift the layout), release. */
export async function drag(
  from: Waypoint,
  waypoints: Waypoint | Waypoint[],
  opts: DragOptions = {},
): Promise<void> {
  const { steps = 12, settle = 0, onWaypoint, release = true } = opts;
  const list = Array.isArray(waypoints) ? waypoints : [waypoints];
  if (!isPoint(from)) from.scrollIntoView({ block: 'nearest' });
  const start = resolvePoint(from);
  await moveTo(start);
  await down();
  for (let i = 0; i < list.length; i++) {
    const p = resolvePoint(list[i]);
    await moveTo(p, steps);
    if (settle) await wait(settle);
    await onWaypoint?.(i, p);
  }
  if (release) await up();
}

export function isMonotonic(seq: number[]): boolean {
  let dir = 0;
  for (let i = 1; i < seq.length; i++) {
    const step = Math.sign(seq[i] - seq[i - 1]);
    if (step === 0) continue;
    if (dir === 0) dir = step;
    else if (step !== dir) return false;
  }
  return true;
}

/** Retry an assertion until it passes or the timeout runs out, like Playwright's web-first `expect`. */
export async function until(
  assertion: () => void,
  timeout = 2000,
): Promise<void> {
  const end = performance.now() + timeout;
  for (;;) {
    try {
      assertion();
      return;
    } catch (e) {
      if (performance.now() > end) throw e;
      await frame();
    }
  }
}

/** The dnd setup of the playground app the fixtures came from: the hitbox and edge auto-scroll plugins. */
export const playgroundDnd = () =>
  provideDnd({
    plugins: {
      hitbox: { attachClosestEdge, extractClosestEdge },
      autoScroll: edgeAutoScroll,
    },
  });

/** Mount a fixture into the real document and let the deferred `afterNextRender` wiring run. */
export async function mount<T>(
  cmp: Type<T>,
  viewport: { width: number; height: number } = { width: 1280, height: 720 },
): Promise<ComponentFixture<T>> {
  await page.viewport(viewport.width, viewport.height);
  TestBed.configureTestingModule({ providers: [playgroundDnd()] });
  const fixture = TestBed.createComponent(cmp);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  await frames(2);
  return fixture;
}

export async function resetPointer(): Promise<void> {
  await userEvent.cleanup();
  last = { x: 0, y: 0 };
  window.scrollTo(0, 0);
}

type Cdp = { send(method: string, params?: unknown): Promise<unknown> };

/** Turn on touch support for the page, like Playwright's `hasTouch` context option (Chromium only). */
export async function emulateTouch(enabled: boolean): Promise<void> {
  await (cdp() as Cdp).send('Emulation.setTouchEmulationEnabled', {
    enabled,
    maxTouchPoints: enabled ? 1 : undefined,
  });
}

/** Real touch through CDP (Chromium only): native scrolling and `touch-action` apply. */
export function cdpTouch() {
  const session = cdp() as Cdp;
  const send = (type: string, points: Point[]) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })),
    });
  return {
    start: (p: Point) => send('touchStart', [p]),
    move: (p: Point) => send('touchMove', [p]),
    end: () => send('touchEnd', []),
    /** Glide in small steps, a frame apart, like a finger. */
    async glide(from: Point, to: Point, steps = 12) {
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          },
        ]);
        await wait(16);
      }
    },
  };
}

/** Clean text of a row: trimmed, the grip glyph removed. */
export const label = (e: Element): string =>
  (e.textContent ?? '').replace(/⠿/g, '').trim();

export const labels = (root: ParentNode, selector: string): string[] =>
  Array.from(root.querySelectorAll(selector), label);

export const texts = (root: ParentNode, selector: string): string[] =>
  Array.from(root.querySelectorAll(selector), (e) =>
    (e.textContent ?? '').trim(),
  );

/** The first `selector` match under `root` whose trimmed text contains `text` (or matches it). */
export function byText(
  root: ParentNode,
  selector: string,
  text: string | RegExp,
): HTMLElement {
  const hit = Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (e) => {
      const t = (e.textContent ?? '').trim();
      return typeof text === 'string' ? t.includes(text) : text.test(t);
    },
  );
  if (!hit) throw new Error(`no ${selector} with text ${String(text)}`);
  return hit;
}

export const countText = (
  root: ParentNode,
  selector: string,
  text: string,
): number =>
  Array.from(root.querySelectorAll(selector)).filter((e) =>
    (e.textContent ?? '').includes(text),
  ).length;

/** A real HTML5 drag through Playwright's `dragTo` (atomic: press, move, release). */
export async function nativeDrag(
  source: Element,
  target: Element,
  targetPosition?: Point,
): Promise<void> {
  await userEvent.dragAndDrop(
    page.elementLocator(source),
    page.elementLocator(target),
    targetPosition ? { targetPosition } : undefined,
  );
}

export function dispatchDrag(
  el: Element,
  type: string,
  dataTransfer: DataTransfer,
): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }),
  );
}

/** Chrome's real layout and style-recalc counters through CDP (Chromium only). */
export async function perfCounters() {
  const session = cdp() as {
    send(method: string, params?: unknown): Promise<unknown>;
  };
  await session.send('Performance.enable');
  return async () => {
    const { metrics } = (await session.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[];
    };
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
    return { layout: get('LayoutCount'), recalc: get('RecalcStyleCount') };
  };
}

/** Force `n` layouts in the test document: the control that proves the counter sees this frame. */
export function forceLayouts(n: number): void {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  for (let i = 0; i < n; i++) {
    probe.style.width = `${10 + i}px`;
    void probe.offsetWidth;
  }
  probe.remove();
}

/** CDP (perf counters, real touch) exists only in Chromium. */
export const notChromium = server.browser !== 'chromium';
