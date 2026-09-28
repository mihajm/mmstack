import { expect, test, type Page } from '@playwright/test';

/**
 * What Chrome keeps from `@mmstack/telemetry-devtools`. The unit suite pins what
 * the sink calls; this spec records a real trace over CDP and asserts the trace
 * events the Performance panel is drawn from: labels, tracks, group, colour,
 * zero-length entries, seed order, and alignment with the click that caused
 * them. In rich mode the sink clears its `performance.measure` entries one
 * microtask after emitting, so the trace is the only place they survive.
 *
 * Observed shapes (Chromium, pinned here): a zero-length measure is one
 * `blink.user_timing` event with `ph: 'n'`; a non-zero one is a `b`/`e` pair
 * (detail on `b` only). `detail` is serialised as a JSON string under
 * `args.detail`; `args.callTime` is when `measure` ran. `console.timeStamp`
 * with track arguments is a `devtools.timeline` `TimeStamp` event whose
 * `args.data` carries `message`/`name`, `start`/`end`, `track`, `trackGroup`
 * and `color`. Trace `ts`, `dur`, `start` and `end` are microseconds.
 */
type Cdp = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  args?: Record<string, unknown>;
}

interface DevtoolsDetail {
  dataType?: string;
  track?: string;
  trackGroup?: string;
  color?: string;
  tooltipText?: string;
  properties?: [string, string][];
}

/** One user-timing measure as the trace kept it. */
interface Measure {
  start: number;
  end: number;
  callTime: number;
  devtools: DevtoolsDetail;
}

interface TimeStampData {
  message?: string;
  name?: string;
  start?: number;
  end?: number;
  track?: string;
  trackGroup?: string;
  color?: string;
}

const CATEGORIES =
  'blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline';
const ORIGIN_LABEL = 'click on button#demo · demo';
const FINDING_LABEL = 'DEMO_FINDING: Demo finding: nothing to fix.';
const SEEDS = ['Interactions', 'Spans', 'Events', 'Findings'];
/** `Date.now()` is integer ms, so a converted start may sit up to 1 ms early. */
const STAMP_RESOLUTION_US = 1000;

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'CDP tracing is Chromium-only',
);

/** Records a trace around `run`; tracing starts before navigation so seeds are caught. */
async function record(
  page: Page,
  run: () => Promise<void>,
): Promise<TraceEvent[]> {
  const cdp: Cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (chunk: { value: TraceEvent[] }) => {
    events.push(...chunk.value);
  });
  await cdp.send('Tracing.start', {
    categories: CATEGORIES,
    transferMode: 'ReportEvents',
  });
  await run();
  await page.waitForTimeout(100);
  const complete = new Promise<void>((resolve) =>
    cdp.once('Tracing.tracingComplete', () => resolve()),
  );
  await cdp.send('Tracing.end');
  await complete;
  return events;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('demo-origin')).toBeVisible();
}

function userTimings(events: TraceEvent[], name: string): TraceEvent[] {
  return events.filter((e) => e.cat === 'blink.user_timing' && e.name === name);
}

/** The single measure named `name`, whichever of the two trace shapes it took. */
function measure(events: TraceEvent[], name: string): Measure {
  const own = userTimings(events, name);
  const phases = own
    .map((e) => e.ph)
    .sort()
    .join('');
  expect(phases, `trace shape of measure "${name}"`).toMatch(/^(n|be)$/);
  const head = own.find((e) => e.ph === 'n' || e.ph === 'b')!;
  const tail = own.find((e) => e.ph === 'e') ?? head;
  const detail = JSON.parse(head.args!['detail'] as string) as {
    devtools: DevtoolsDetail;
  };
  return {
    start: head.ts,
    end: tail.ts,
    callTime: head.args!['callTime'] as number,
    devtools: detail.devtools,
  };
}

function clickDispatches(events: TraceEvent[]): TraceEvent[] {
  return events.filter(
    (e) =>
      e.name === 'EventDispatch' &&
      e.ph === 'X' &&
      (e.args?.['data'] as { type?: string } | undefined)?.type === 'click',
  );
}

function timeStamps(events: TraceEvent[], label: string): TimeStampData[] {
  return events
    .filter((e) => e.name === 'TimeStamp' && e.cat === 'devtools.timeline')
    .map((e) => e.args?.['data'] as TimeStampData)
    .filter((d) => d.message === label);
}

test('rich: origin span is captured with its devtools detail', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
    await page.getByTestId('demo-origin').click();
  });
  const span = measure(events, ORIGIN_LABEL);
  expect(span.devtools.dataType).toBe('track-entry');
  expect(span.devtools.track).toBe('Interactions');
  expect(span.devtools.trackGroup).toBe('mmstack');
  expect(span.devtools.color).toBe('primary');
  expect(span.devtools.properties).toEqual(
    expect.arrayContaining([
      ['origin.kind', 'interaction'],
      ['origin.name', 'click'],
      ['origin.target', 'button#demo'],
      ['track', 'Interactions'],
    ]),
  );
});

test('rich: the trace keeps the span after the sink clears the measure', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
    await page.getByTestId('demo-origin').click();
  });
  const retained = await page.evaluate(
    (label) => performance.getEntriesByName(label).length,
    ORIGIN_LABEL,
  );
  expect(retained).toBe(0);
  const span = measure(events, ORIGIN_LABEL);
  expect(span.devtools.track).toBe('Interactions');
  expect(span.devtools.trackGroup).toBe('mmstack');
});

test('rich: finding entry carries colour, tooltip and properties', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
    await page.getByTestId('demo-finding').click();
  });
  const names = events
    .filter((e) => e.cat === 'blink.user_timing')
    .map((e) => e.name)
    .filter((n) => n.startsWith('DEMO_FINDING:'));
  expect(new Set(names)).toEqual(new Set([FINDING_LABEL]));
  const finding = measure(events, FINDING_LABEL);
  expect(finding.devtools.dataType).toBe('track-entry');
  expect(finding.devtools.track).toBe('Findings');
  expect(finding.devtools.trackGroup).toBe('mmstack');
  expect(finding.devtools.color).toBe('warning');
  expect(finding.devtools.tooltipText).toBe('Demo finding: nothing to fix.');
  expect(finding.devtools.properties).toEqual(
    expect.arrayContaining([
      ['severity', 'warn'],
      ['fingerprint', expect.stringContaining('DEMO_FINDING')],
    ]),
  );
});

test('rich: seeds are zero-length, placed at the time origin, in order', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
  });
  const seeds = SEEDS.map((name) => ({ name, ...measure(events, name) }));
  for (const seed of seeds) {
    expect(seed.end - seed.start, `${seed.name} length`).toBe(0);
    expect(seed.devtools.dataType).toBe('track-entry');
    expect(seed.devtools.track).toBe(seed.name);
    expect(seed.devtools.trackGroup).toBe('mmstack');
    expect(seed.devtools.color).toBeUndefined();
  }
  // All seeds are placed at the same instant (0.003 ms after the time origin),
  // so their placement is equal; the order the panel sees is emission order.
  const placed = new Set(seeds.map((s) => s.start));
  expect(placed.size).toBe(1);
  const seedIndex = (name: string) =>
    events.findIndex((e) => e.cat === 'blink.user_timing' && e.name === name);
  for (let i = 1; i < seeds.length; i++) {
    expect(
      seeds[i].callTime,
      `${seeds[i].name} after ${seeds[i - 1].name}`,
    ).toBeGreaterThan(seeds[i - 1].callTime);
    expect(seedIndex(seeds[i].name)).toBeGreaterThan(
      seedIndex(seeds[i - 1].name),
    );
  }
});

test('rich: finding entry is zero-length', async ({ page }) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
    await page.getByTestId('demo-finding').click();
  });
  const finding = measure(events, FINDING_LABEL);
  expect(finding.devtools.track).toBe('Findings');
  expect(finding.devtools.trackGroup).toBe('mmstack');
  expect(finding.end - finding.start).toBe(0);
});

test('rich: origin span aligns with the click dispatch that caused it', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry');
    await page.getByTestId('demo-origin').click();
  });
  const span = measure(events, ORIGIN_LABEL);
  expect(span.devtools.track).toBe('Interactions');
  expect(span.devtools.trackGroup).toBe('mmstack');
  const clicks = clickDispatches(events);
  expect(clicks).toHaveLength(1);
  const [click] = clicks;
  const dispatchEnd = click.ts + click.dur!;
  // The span ran inside the dispatch. Its stamps are integer epoch ms, so the
  // converted start may precede the dispatch by under 1 ms; the end never
  // runs past it.
  expect(span.start).toBeGreaterThanOrEqual(click.ts - STAMP_RESOLUTION_US);
  expect(span.start).toBeLessThanOrEqual(dispatchEnd);
  expect(span.end).toBeGreaterThanOrEqual(span.start);
  expect(span.end).toBeLessThanOrEqual(dispatchEnd);
});

test('cheap: console.timeStamp entry carries label, track, group and colour', async ({
  page,
}) => {
  const events = await record(page, async () => {
    await open(page, '/telemetry?devtools=cheap');
    await page.getByTestId('demo-origin').click();
  });
  expect(userTimings(events, ORIGIN_LABEL)).toHaveLength(0);
  const stamps = timeStamps(events, ORIGIN_LABEL);
  expect(stamps).toHaveLength(1);
  const [stamp] = stamps;
  expect(stamp.name).toBe(ORIGIN_LABEL);
  expect(stamp.track).toBe('Interactions');
  expect(stamp.trackGroup).toBe('mmstack');
  expect(stamp.color).toBe('primary');
  expect(typeof stamp.start).toBe('number');
  expect(stamp.end).toBeGreaterThanOrEqual(stamp.start!);
  for (const seed of SEEDS) {
    const [placed] = timeStamps(events, seed);
    expect(placed, `seed ${seed}`).toBeDefined();
    expect(placed.track).toBe(seed);
    expect(placed.trackGroup).toBe('mmstack');
    expect(placed.end).toBe(placed.start);
  }
});
