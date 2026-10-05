import { signal, type ResourceStatus } from '@angular/core';
import { type Sink } from './sink';
import { TestBed } from '@angular/core/testing';
import { error, outcomeOf } from '@mmstack/primitives';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import {
  provideSentinelTelemetry,
  SENTINEL_ERROR_FINDING,
} from './sentinel-telemetry';

function failedRef() {
  return {
    status: signal<ResourceStatus>('error'),
    value: signal<unknown>(undefined),
    error: signal<unknown>(new TypeError('offline')),
    hasValue: () => false,
  };
}

function setup(withProvider = true) {
  const sink = memorySink();
  TestBed.configureTestingModule({
    providers: [
      provideTelemetry({ sinks: [sink] }),
      ...(withProvider ? [provideSentinelTelemetry()] : []),
    ],
  });
  return sink;
}

describe('provideSentinelTelemetry', () => {
  it('an outcomeOf over a failed ref mints once and yields exactly one finding; a second read none', () => {
    const sink = setup();
    TestBed.tick(); // runs the environment initializer

    const outcome = outcomeOf(failedRef());
    outcome();
    expect(sink.findings.length).toBe(1);
    expect(sink.findings[0].finding).toMatchObject({
      code: SENTINEL_ERROR_FINDING,
      severity: 'error',
      path: 'sentinel.edge',
      node: 'external-fault',
      fingerprint: 'SENTINEL_ERROR|sentinel.edge|external-fault',
    });
    expect(sink.findings[0].attrs).toMatchObject({
      origin: 'edge',
      subclass: 'external-fault',
      causeType: 'TypeError',
    });

    outcome();
    expect(sink.findings.length).toBe(1);
  });

  it('an authored mint is reported with its own origin and subclass', () => {
    const sink = setup();
    TestBed.tick();
    error('bad input');
    expect(sink.findings.map((f) => f.finding.fingerprint)).toEqual([
      'SENTINEL_ERROR|sentinel.authored|author-fault',
    ]);
    expect(sink.findings[0].attrs).toMatchObject({ causeType: 'string' });
  });

  it('a sink that writes a signal still records a mint made inside a computed', () => {
    const count = signal(0);
    const sink: Sink = {
      name: 'signal-sink',
      ready: signal(true).asReadonly(),
      recordFinding: () => count.update((n) => n + 1),
    };
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({ sinks: [sink] }),
        provideSentinelTelemetry(),
      ],
    });
    TestBed.tick();
    outcomeOf(failedRef())(); // outcomeOf mints inside its computed
    expect(count()).toBe(1);
  });

  it('without the provider a mint reports nothing', () => {
    const sink = setup(false);
    TestBed.tick();
    outcomeOf(failedRef())();
    expect(sink.findings).toEqual([]);
  });

  it('destroying the injector uninstalls the reporter', () => {
    const sink = setup();
    TestBed.tick();
    TestBed.resetTestingModule();
    error('after teardown');
    expect(sink.findings).toEqual([]);
  });
});
