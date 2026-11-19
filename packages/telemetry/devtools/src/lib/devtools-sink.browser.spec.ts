import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY } from '@mmstack/telemetry-core';
import { cdp, userEvent } from 'vitest/browser';
import { devtoolsSink, type DevtoolsSinkConfig } from './devtools-sink';

/**
 * What Chrome keeps from the devtools sink. The unit suite pins what the sink calls; this spec
 * records a real trace over CDP and asserts the trace events the Performance panel is drawn from:
 * labels, tracks, group, colour, zero-length entries, seed order, and alignment with the click that
 * caused them. In rich mode the sink clears its measures one microtask after emitting, so the
 * trace is the only place they survive.
 *
 * Observed shapes (Chromium): a zero-length measure is one `blink.user_timing` event with
 * `ph: 'n'`; a non-zero one is a `b`/`e` pair (detail on `b` only). `detail` is a JSON string under
 * `args.detail`; `args.callTime` is when `measure` ran. `console.timeStamp` with track arguments is
 * a `devtools.timeline` `TimeStamp` event whose `args.data` carries `message`/`name`,
 * `start`/`end`, `track`, `trackGroup` and `color`. Trace `ts`, `dur`, `start` and `end` are
 * microseconds.
 */
/** The Playwright CDP session surface vitest hands out (send/on/off/once). */
interface Cdp {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (payload: never) => void): void;
}

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

@Component({
  selector: 'mm-devtools-demo',
  template: `
    <button data-testid="demo-origin" (click)="origin()">origin</button>
    <button data-testid="demo-finding" (click)="finding()">finding</button>
  `,
})
class Demo {
  private readonly telemetry = inject(TELEMETRY);

  origin(): void {
    this.telemetry.withOrigin(
      { kind: 'interaction', name: 'click', target: 'button#demo' },
      () =>
        this.telemetry.span('demo', () => undefined, {
          attrs: { track: 'Interactions' },
        }),
    );
  }

  finding(): void {
    this.telemetry.finding('DEMO_FINDING', {
      severity: 'warn',
      path: 'examples.telemetry',
      node: 'finding-button',
      message: 'Demo finding: nothing to fix.',
    });
  }
}

/** Records a trace around `run`; the sink is built inside it, so the seeds are caught. */
async function record(
  mode: DevtoolsSinkConfig['mode'],
  click?: 'demo-origin' | 'demo-finding',
): Promise<TraceEvent[]> {
  const session = cdp() as unknown as Cdp;
  const events: TraceEvent[] = [];
  let collecting = true;
  // vitest's cdp().off (and once, which calls it) cannot detach a listener on the
  // Playwright side, so listeners stay attached and a stale one just stops collecting
  const onData = (chunk: { value: TraceEvent[] }) => {
    if (collecting) events.push(...chunk.value);
  };
  session.on('Tracing.dataCollected', onData);
  await session.send('Tracing.start', {
    categories: CATEGORIES,
    transferMode: 'ReportEvents',
  });

  TestBed.configureTestingModule({
    providers: [
      provideTelemetry({ sinks: [devtoolsSink({ mode, seed: SEEDS })] }),
    ],
  });
  const fixture = TestBed.createComponent(Demo);
  fixture.detectChanges();
  if (click) {
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-testid="${click}"]`,
    ) as HTMLElement;
    await userEvent.click(button);
  }
  await new Promise((r) => setTimeout(r, 100));

  const complete = new Promise<void>((resolve) =>
    session.on('Tracing.tracingComplete', () => resolve()),
  );
  await session.send('Tracing.end');
  await complete;
  collecting = false;
  return events;
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

describe('devtools sink in Chrome (trace)', () => {
  it('rich: the origin span keeps its devtools detail in the trace after the sink clears it', async () => {
    const events = await record('rich', 'demo-origin');
    expect(performance.getEntriesByName(ORIGIN_LABEL)).toHaveLength(0);
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

  it('rich: a finding is one zero-length entry with colour, tooltip and properties', async () => {
    const events = await record('rich', 'demo-finding');
    const names = events
      .filter((e) => e.cat === 'blink.user_timing')
      .map((e) => e.name)
      .filter((n) => n.startsWith('DEMO_FINDING:'));
    expect(new Set(names)).toEqual(new Set([FINDING_LABEL]));
    const finding = measure(events, FINDING_LABEL);
    expect(finding.end - finding.start).toBe(0);
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

  it('rich: seeds are zero-length, placed together, in seed order', async () => {
    const events = await record('rich');
    const seeds = SEEDS.map((name) => ({ name, ...measure(events, name) }));
    for (const seed of seeds) {
      expect(seed.end - seed.start, `${seed.name} length`).toBe(0);
      expect(seed.devtools.dataType).toBe('track-entry');
      expect(seed.devtools.track).toBe(seed.name);
      expect(seed.devtools.trackGroup).toBe('mmstack');
      expect(seed.devtools.color).toBeUndefined();
    }
    expect(new Set(seeds.map((s) => s.start)).size).toBe(1);
    const seedIndex = (name: string) =>
      events.findIndex((e) => e.cat === 'blink.user_timing' && e.name === name);
    for (let i = 1; i < seeds.length; i++) {
      expect(seeds[i].callTime).toBeGreaterThan(seeds[i - 1].callTime);
      expect(seedIndex(seeds[i].name)).toBeGreaterThan(
        seedIndex(seeds[i - 1].name),
      );
    }
  });

  it('rich: the origin span sits inside the click dispatch that caused it', async () => {
    const events = await record('rich', 'demo-origin');
    const span = measure(events, ORIGIN_LABEL);
    const clicks = clickDispatches(events);
    expect(clicks).toHaveLength(1);
    const [click] = clicks;
    const dispatchEnd = click.ts + click.dur!;
    // stamps are integer epoch ms, so the start may precede the dispatch by under 1 ms
    expect(span.start).toBeGreaterThanOrEqual(click.ts - STAMP_RESOLUTION_US);
    expect(span.start).toBeLessThanOrEqual(dispatchEnd);
    expect(span.end).toBeGreaterThanOrEqual(span.start);
    expect(span.end).toBeLessThanOrEqual(dispatchEnd);
  });

  it('cheap: console.timeStamp entries carry label, track, group and colour', async () => {
    const events = await record('cheap', 'demo-origin');
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
});
