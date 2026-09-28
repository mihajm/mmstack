// Cost tripwire, not a benchmark. Three arms run interleaved on the same 200-iteration loop:
// bare (the loop's own work, with a trivial local call in place of each facade call), the noop
// facade, and an enabled facade whose sink discards everything. The guard that matters is
// noop/bare: the noop facade must stay within an order of magnitude of doing nothing. enabled/noop
// is a loose tripwire against a catastrophic regression in the enabled path.
//
// Measured on a dev machine (best of 5 rounds, five runs): bare 0.0065–0.0079ms, noop
// 0.0045–0.0059ms, enabled 0.94–1.12ms; noop/bare 0.7–0.8x, enabled/noop 180–214x. The enabled
// path mints ids and stamps clocks per span, which sets that ratio's floor.
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTelemetry } from './provide';
import { type Sink, type SinkSpan } from './sink';
import { TELEMETRY, type Telemetry } from './telemetry';

const ITERATIONS = 200;
const ROUNDS = 5;
const MAX_NOOP_RATIO = 20;
const MAX_ENABLED_RATIO = 1000;

const DISCARD_SPAN: SinkSpan = {
  setAttrs() {
    /* discard */
  },
  setError() {
    /* discard */
  },
  end() {
    /* discard */
  },
};

/** Implements every capability with empty bodies — unlike `memorySink`, it retains nothing. */
function discardingSink(): Sink {
  return {
    name: 'discard',
    ready: signal(true).asReadonly(),
    startSpan: () => DISCARD_SPAN,
    capture() {
      /* discard */
    },
    recordError() {
      /* discard */
    },
    record() {
      /* discard */
    },
    emitLog() {
      /* discard */
    },
    identify() {
      /* discard */
    },
    setGlobalAttrs() {
      /* discard */
    },
    recordFinding() {
      /* discard */
    },
  };
}

let hole = 0;

/** The loop's own work: same closures, same literals, a trivial call in place of each facade call. */
function touch(name: string, value?: unknown): void {
  if (value !== undefined) hole += name.length;
}
function run(name: string, fn: () => void): void {
  touch(name);
  fn();
}

function bare(): number {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    run('w', () => {
      touch('e', { i });
      touch('m', 1);
      touch('F', { severity: 'warn', path: 'w', message: 'm' });
    });
  }
  return performance.now() - start;
}

function workload(t: Telemetry): number {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    t.span('w', () => {
      t.event('e', { i });
      t.metric('m', 1);
      t.finding('F', { severity: 'warn', path: 'w', message: 'm' });
    });
  }
  return performance.now() - start;
}

/** Floor at the timer's practical resolution so a 0ms reading can't divide by zero. */
function ratio(a: number, b: number): number {
  return a / Math.max(b, 0.001);
}

describe('telemetry cost tripwire', () => {
  it(`noop stays within ${MAX_NOOP_RATIO}x of bare work; enabled within ${MAX_ENABLED_RATIO}x of noop`, () => {
    const noop = TestBed.inject(TELEMETRY); // no provideTelemetry → the noop
    const enabledInjector = createEnvironmentInjector(
      [provideTelemetry({ sinks: [discardingSink()] })],
      TestBed.inject(EnvironmentInjector),
    );
    const enabled = enabledInjector.get(TELEMETRY);
    expect(noop.enabled()).toBe(false);
    expect(enabled.enabled()).toBe(true);

    let bareMs = Number.POSITIVE_INFINITY;
    let noopMs = Number.POSITIVE_INFINITY;
    let enabledMs = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round++) {
      bareMs = Math.min(bareMs, bare());
      noopMs = Math.min(noopMs, workload(noop));
      enabledMs = Math.min(enabledMs, workload(enabled));
    }
    enabledInjector.destroy();

    const noopRatio = ratio(noopMs, bareMs);
    const enabledRatio = ratio(enabledMs, noopMs);
    console.info(
      `[telemetry cost] ${ITERATIONS} iterations, best of ${ROUNDS}: bare ${bareMs.toFixed(4)}ms, noop ${noopMs.toFixed(4)}ms, enabled ${enabledMs.toFixed(4)}ms; noop/bare ${noopRatio.toFixed(1)}x, enabled/noop ${enabledRatio.toFixed(1)}x (hole ${hole > 0})`,
    );
    // the guard that matters: the noop facade stays within an order of magnitude of doing nothing
    expect(noopRatio).toBeLessThanOrEqual(MAX_NOOP_RATIO);
    // catastrophic-regression tripwire for the enabled path
    expect(enabledRatio).toBeLessThanOrEqual(MAX_ENABLED_RATIO);
  });
});
