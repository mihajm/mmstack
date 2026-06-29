import { type Locator, type Page } from '@playwright/test';

/**
 * Pointer-drag harness for the pointer-based dnd engine.
 *
 * Native HTML5 `dragTo` is atomic — one jump, no observable mid-drag state — so
 * it can't surface jank. A pointer gesture is `down → move(steps) → up`, which
 * we can step frame-by-frame and sample (screenshot or engine trace) at every
 * waypoint. That stepping is the whole point: the deep assertions live in the
 * trajectory (insert-index sequence, indicator edge per frame), not the final
 * order alone.
 */

export type Point = { x: number; y: number };

/** A waypoint is either a live element (its current center) or absolute viewport coords. */
export type Waypoint = Locator | Point;

const isPoint = (w: Waypoint): w is Point =>
  typeof (w as Point).x === 'number' && typeof (w as Point).y === 'number';

/**
 * Resolve a waypoint to viewport coords *now*. Locators resolve lazily (called
 * mid-drag, after earlier moves have shifted the layout) so chained waypoints
 * track where an item actually moved to, not where it started.
 */
export async function resolvePoint(w: Waypoint): Promise<Point> {
  if (isPoint(w)) return w;
  const box = await w.boundingBox();
  if (!box) throw new Error('pointer harness: waypoint locator has no bounding box (not visible / detached)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Offset a waypoint by a fraction of the element box, e.g. top edge: `at(item, { fy: 0.05 })`. */
export async function at(loc: Locator, frac: { fx?: number; fy?: number }): Promise<Point> {
  const box = await loc.boundingBox();
  if (!box) throw new Error('pointer harness: at() locator has no bounding box');
  return {
    x: box.x + box.width * (frac.fx ?? 0.5),
    y: box.y + box.height * (frac.fy ?? 0.5),
  };
}

export type DragOptions = {
  /** Sub-steps Playwright interpolates between consecutive waypoints. @default 12 */
  steps?: number;
  /** ms to wait after reaching each waypoint, to let rAF/throttle settle before sampling. @default 0 */
  settle?: number;
  /** Invoked after the pointer reaches each waypoint (and after `settle`). Index is waypoint order. */
  onWaypoint?: (index: number, point: Point) => Promise<void> | void;
  /** Release the button at the end. Set false to leave the gesture open for manual inspection. @default true */
  release?: boolean;
};

/**
 * Press at `from`, then move through `waypoints` in order, sampling at each.
 * `pointerDrag` would have a name clash with the primitive; this is the test driver.
 */
export async function drag(
  page: Page,
  from: Waypoint,
  waypoints: Waypoint | Waypoint[],
  opts: DragOptions = {},
): Promise<void> {
  const { steps = 12, settle = 0, onWaypoint, release = true } = opts;
  const list = Array.isArray(waypoints) ? waypoints : [waypoints];

  // raw mouse.down doesn't auto-scroll like .click() — bring an off-screen start
  // element into view first, or the press lands on empty space.
  if (!isPoint(from)) await (from as Locator).scrollIntoViewIfNeeded();
  const start = await resolvePoint(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  for (let i = 0; i < list.length; i++) {
    const p = await resolvePoint(list[i]);
    await page.mouse.move(p.x, p.y, { steps });
    if (settle) await page.waitForTimeout(settle);
    await onWaypoint?.(i, p);
  }

  if (release) await page.mouse.up();
}

/**
 * Drag while screenshotting at each waypoint into `.filmstrips/<name>-NN.png`.
 * Returns the file paths so the caller (or a human reading the run) can eyeball
 * the frames for flicker / shake / lag / off-by-one. Pass `clip` to shoot a
 * single element instead of the full page.
 */
export async function filmstrip(
  page: Page,
  name: string,
  from: Waypoint,
  waypoints: Waypoint[],
  opts: DragOptions & { clip?: Locator; dir?: string } = {},
): Promise<string[]> {
  const dir = opts.dir ?? 'apps/playground-e2e/.filmstrips';
  const clip = opts.clip;
  const shots: string[] = [];

  await drag(page, from, waypoints, {
    ...opts,
    onWaypoint: async (i, p) => {
      const path = `${dir}/${name}-${String(i).padStart(2, '0')}.png`;
      await (clip ?? page).screenshot({ path });
      shots.push(path);
      await opts.onWaypoint?.(i, p);
    },
  });

  return shots;
}

/**
 * Engine trace seam. The pointer engine pushes per-pointermove samples onto
 * `window.__mmDndTrace` (dev-only). Tests read the sequence and assert
 * invariants on it — e.g. the insert index is monotonic / never oscillates.
 * Until the engine writes it, this returns []. Shape is engine-defined.
 */
export async function readTrace<T = unknown>(page: Page): Promise<T[]> {
  return page.evaluate(() => (window as unknown as { __mmDndTrace?: unknown[] }).__mmDndTrace ?? []) as Promise<T[]>;
}

export async function clearTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mmDndTrace?: unknown[] }).__mmDndTrace = [];
  });
}

/** True when a numeric sequence never reverses direction (a cheap jank/oscillation check). */
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
