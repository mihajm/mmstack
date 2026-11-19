import { TestBed } from '@angular/core/testing';
import {
  localStorageConsentStore,
  type ConsentDecision,
  type ConsentStore,
  type TrackingRequirement,
} from './consent';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { TELEMETRY, type TelemetryConfig } from './telemetry';

type Decisions = Readonly<Record<string, ConsentDecision>> | null;

const PERF: TrackingRequirement = {
  id: 'perf',
  category: 'perf',
  purpose: 'performance metrics',
};
const ANALYTICS: TrackingRequirement = {
  id: 'analytics',
  category: 'analytics',
  purpose: 'product analytics',
};

function setup(consent?: TelemetryConfig['consent']) {
  const sink = memorySink();
  TestBed.configureTestingModule({
    providers: [provideTelemetry({ sinks: [sink], consent })],
  });
  return { sink, telemetry: TestBed.inject(TELEMETRY) };
}

function resolvableStore() {
  let resolve!: (v: Decisions) => void;
  const stored = new Promise<Decisions>((r) => (resolve = r));
  const store: ConsentStore = { get: () => stored, set: () => undefined };
  return { store, resolve };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('consent contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('without consent config the consent signal is an empty record', () => {
    const { telemetry } = setup();
    expect(telemetry.consent()).toEqual({});
  });

  it('replays deliveries held during hydration in emit order', async () => {
    const { store, resolve } = resolvableStore();
    const { sink, telemetry } = setup({ requirements: [PERF], store });

    telemetry.event('a', undefined, { category: 'perf' });
    telemetry.event('b', undefined, { category: 'perf' });
    telemetry.log('info', 'c', undefined, { category: 'perf' });
    telemetry.event('d', undefined, { category: 'perf' });
    resolve({ perf: 'granted' });
    await flush();

    expect(sink.events.map((e) => e.name)).toEqual(['a', 'b', 'd']);
    expect(sink.logs.map((l) => l.body)).toEqual(['c']);
  });

  it('keeps emit order when an early decision releases part of the queue', async () => {
    const { store, resolve } = resolvableStore();
    const { sink, telemetry } = setup({
      requirements: [PERF, ANALYTICS],
      store,
    });

    telemetry.event('p1', undefined, { category: 'perf' });
    telemetry.event('a1', undefined, { category: 'analytics' });
    telemetry.event('p2', undefined, { category: 'perf' });
    telemetry.event('a2', undefined, { category: 'analytics' });
    telemetry.decide('perf', true);
    expect(sink.events.map((e) => e.name)).toEqual(['p1', 'p2']);

    resolve({ analytics: 'granted' });
    await flush();
    expect(sink.events.map((e) => e.name)).toEqual(['p1', 'p2', 'a1', 'a2']);
  });

  it('a rejecting store.get settles hydration at once and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sink, telemetry } = setup({
        requirements: [PERF],
        mode: 'implicit',
        store: {
          get: () => Promise.reject(new Error('x')),
          set: () => undefined,
        },
      });
      telemetry.event('held', undefined, { category: 'perf' });
      expect(sink.events).toEqual([]);
      await flush();
      expect(sink.events.map((e) => e.name)).toEqual(['held']);
      expect(warn).toHaveBeenCalledWith(
        '[telemetry] ConsentStore.get failed',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // an unhandled rejection here fails the run on its own
  it('a rejecting store.set is handled and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { telemetry } = setup({
        requirements: [PERF],
        store: {
          get: () => null,
          set: () => Promise.reject(new Error('x')),
        },
      });
      telemetry.decide('perf', true);
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalledWith(
        '[telemetry] ConsentStore.set failed',
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a held delivery does not survive teardown, even if the store resolves later', async () => {
    const { store, resolve } = resolvableStore();
    const { sink, telemetry } = setup({ requirements: [PERF], store });
    telemetry.event('held', undefined, { category: 'perf' });
    TestBed.resetTestingModule();
    resolve({ perf: 'granted' });
    await flush();
    expect(sink.events).toEqual([]);
  });

  it('clears the hydration timer when the store settles', async () => {
    vi.useFakeTimers();
    const { store, resolve } = resolvableStore();
    setup({ requirements: [PERF], store });
    TestBed.tick();
    expect(vi.getTimerCount()).toBe(1);
    resolve({ perf: 'granted' });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the hydration timer when the injector is destroyed', () => {
    vi.useFakeTimers();
    const { store } = resolvableStore();
    setup({ requirements: [PERF], store });
    TestBed.tick();
    expect(vi.getTimerCount()).toBe(1);
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('localStorageConsentStore reads null when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    const store = localStorageConsentStore();
    expect(store.get()).toBeNull();
  });
});
