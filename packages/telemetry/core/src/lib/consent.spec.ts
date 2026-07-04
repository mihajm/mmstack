import { signal } from '@angular/core';
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

describe('consent (RFC §7)', () => {
  it('without consent config, categories are inert and signals stay empty', () => {
    const { sink, telemetry } = setup();
    telemetry.event('e', { a: 1 }, { category: 'anything' });

    expect(sink.events).toEqual([{ name: 'e', attrs: { a: 1 } }]);
    expect(telemetry.requirements()).toEqual([]);
    expect(telemetry.pending()).toEqual([]);
  });

  describe('required mode (default)', () => {
    it('drops undecided categories, resumes on grant, drops on deny — uncategorized always flows', () => {
      const { sink, telemetry } = setup({ requirements: [PERF] });

      telemetry.event('before', undefined, { category: 'perf' });
      telemetry.event('plain'); // no category → never gated
      expect(sink.events.map((e) => e.name)).toEqual(['plain']);

      telemetry.decide('perf', true);
      telemetry.event('after-grant', undefined, { category: 'perf' });
      expect(sink.events.map((e) => e.name)).toEqual(['plain', 'after-grant']);

      telemetry.decide('perf', false);
      telemetry.event('after-deny', undefined, { category: 'perf' });
      expect(sink.events.map((e) => e.name)).toEqual(['plain', 'after-grant']);
    });

    it('gates every emit kind: error, metric, and log respect the category too', () => {
      const { sink, telemetry } = setup({ requirements: [PERF] });

      telemetry.error(new Error('x'), undefined, { category: 'perf' });
      telemetry.metric('m', 1, undefined, { category: 'perf' });
      telemetry.log('info', 'msg', undefined, { category: 'perf' });
      expect(sink.errors).toEqual([]);
      expect(sink.metrics).toEqual([]);
      expect(sink.logs).toEqual([]);

      telemetry.decide('perf', true);
      telemetry.error(new Error('x'), undefined, { category: 'perf' });
      telemetry.metric('m', 1, undefined, { category: 'perf' });
      telemetry.log('info', 'msg', undefined, { category: 'perf' });
      expect(sink.errors.length).toBe(1);
      expect(sink.metrics.length).toBe(1);
      expect(sink.logs.length).toBe(1);
    });

    it('drops (and dev-warns once for) categories with no declared requirement', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { sink, telemetry } = setup({ requirements: [PERF] });
        telemetry.event('a', undefined, { category: 'undeclared' });
        telemetry.event('b', undefined, { category: 'undeclared' });

        expect(sink.events).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1); // warned once, not per emit
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('implicit mode', () => {
    it('lets undecided and undeclared categories flow; denial still drops', () => {
      const { sink, telemetry } = setup({
        requirements: [PERF],
        mode: 'implicit',
      });

      telemetry.event('undecided', undefined, { category: 'perf' });
      telemetry.event('undeclared', undefined, { category: 'other' });
      expect(sink.events.map((e) => e.name)).toEqual(['undecided', 'undeclared']);

      telemetry.decide('perf', false);
      telemetry.event('denied', undefined, { category: 'perf' });
      expect(sink.events.map((e) => e.name)).toEqual(['undecided', 'undeclared']);
    });
  });

  describe('signals', () => {
    it('pending is exactly the undecided delta and shrinks per decision', () => {
      const { telemetry } = setup({ requirements: [PERF, ANALYTICS] });

      expect(telemetry.requirements()).toEqual([PERF, ANALYTICS]);
      expect(telemetry.pending()).toEqual([PERF, ANALYTICS]);

      telemetry.decide('perf', true);
      expect(telemetry.pending()).toEqual([ANALYTICS]);
      expect(telemetry.consent()).toEqual({ perf: 'granted' });

      telemetry.decide('analytics', false);
      expect(telemetry.pending()).toEqual([]);
      expect(telemetry.consent()).toEqual({ perf: 'granted', analytics: 'denied' });
    });

    it('signal-backed requirements grow reactively: pending() is the new delta (SDUI re-consent)', () => {
      const requirements = signal<readonly TrackingRequirement[]>([PERF]);
      const { sink, telemetry } = setup({ requirements });

      telemetry.decide('perf', true);
      expect(telemetry.pending()).toEqual([]);

      requirements.set([PERF, ANALYTICS]); // server pushes a new section
      expect(telemetry.pending()).toEqual([ANALYTICS]); // prompt only for the delta

      telemetry.event('a', undefined, { category: 'analytics' });
      expect(sink.events).toEqual([]); // not yet granted

      telemetry.decide('analytics', true);
      telemetry.event('b', undefined, { category: 'analytics' });
      expect(sink.events.map((e) => e.name)).toEqual(['b']);
    });
  });

  describe('per-sink requirements', () => {
    it('a sink-scoped denial gates only that sink; a sink-wide requirement gates all', () => {
      const a = memorySink('a');
      const b = memorySink('b');
      TestBed.configureTestingModule({
        providers: [
          provideTelemetry({
            sinks: [a, b],
            consent: {
              requirements: [
                { id: 'analytics-a', category: 'analytics', sink: 'a', purpose: 'x' },
                { id: 'analytics-b', category: 'analytics', sink: 'b', purpose: 'x' },
              ],
            },
          }),
        ],
      });
      const telemetry = TestBed.inject(TELEMETRY);

      telemetry.decide('analytics-a', true);
      telemetry.decide('analytics-b', false);
      telemetry.event('e', undefined, { category: 'analytics' });

      expect(a.events.length).toBe(1);
      expect(b.events.length).toBe(0);
    });
  });

  describe('span gating', () => {
    it('a gated-out span reaches no sink, but its handle still drives ctx and correlation', () => {
      const { sink, telemetry } = setup({ requirements: [PERF] });
      telemetry.decide('perf', false);

      telemetry.span(
        'op',
        (span) => {
          expect(span.ctx.traceId).toMatch(/^[0-9a-f]{32}$/); // handle fully usable
          telemetry.event('inside', { a: 1 }); // uncategorized → flows, correlates
        },
        { category: 'perf' },
      );

      expect(sink.spans).toEqual([]); // span itself gated out
      expect(sink.events.length).toBe(1);
      expect(sink.events[0].attrs).toMatchObject({ a: 1, trace_id: expect.any(String) });
    });
  });

  describe('persistence', () => {
    afterEach(() => localStorage.removeItem('mmstack:telemetry-consent'));

    it('a sync store hydrates immediately: no deferral window, decisions apply from the first emit', () => {
      localStorage.setItem(
        'mmstack:telemetry-consent',
        JSON.stringify({ perf: 'granted', analytics: 'denied' }),
      );
      const { sink, telemetry } = setup({
        requirements: [PERF, ANALYTICS],
        store: localStorageConsentStore(),
      });

      telemetry.event('p', undefined, { category: 'perf' });
      telemetry.event('a', undefined, { category: 'analytics' });

      expect(sink.events.map((e) => e.name)).toEqual(['p']);
      expect(telemetry.pending()).toEqual([]);
    });

    it('decide() persists through the store: a fresh facade rehydrates the decisions', () => {
      const store = localStorageConsentStore();
      const first = setup({ requirements: [PERF], store });
      first.telemetry.decide('perf', true);

      TestBed.resetTestingModule();
      const second = setup({ requirements: [PERF], store });
      second.telemetry.event('e', undefined, { category: 'perf' });

      expect(second.sink.events.length).toBe(1); // granted decision survived
      expect(second.telemetry.pending()).toEqual([]);
    });

    it('a throwing store breaks neither construction nor decide()', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const broken: ConsentStore = {
          get: () => {
            throw new Error('get failed');
          },
          set: () => {
            throw new Error('set failed');
          },
        };
        const { sink, telemetry } = setup({ requirements: [PERF], store: broken });

        expect(() => telemetry.decide('perf', true)).not.toThrow();
        telemetry.event('e', undefined, { category: 'perf' });
        expect(sink.events.length).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('async hydration', () => {
    function deferredStore() {
      let resolve!: (v: Readonly<Record<string, ConsentDecision>> | null) => void;
      const stored = new Promise<Readonly<Record<string, ConsentDecision>> | null>(
        (r) => (resolve = r),
      );
      const sets: Readonly<Record<string, ConsentDecision>>[] = [];
      const store: ConsentStore = {
        get: () => stored,
        set: (d) => {
          sets.push(d);
        },
      };
      return { store, resolve, sets };
    }

    it('defers undecided emits while hydrating, then drains them per the stored decisions', async () => {
      const { store, resolve } = deferredStore();
      const { sink, telemetry } = setup({
        requirements: [PERF, ANALYTICS],
        store,
      });

      telemetry.event('p', undefined, { category: 'perf' });
      telemetry.event('a', undefined, { category: 'analytics' });
      expect(sink.events).toEqual([]); // deferred, not dropped

      resolve({ perf: 'granted', analytics: 'denied' });
      await Promise.resolve();

      expect(sink.events.map((e) => e.name)).toEqual(['p']); // granted drained, denied dropped
    });

    it('defers in implicit mode too: an emit must not race a stored denial', async () => {
      const { store, resolve } = deferredStore();
      const { sink, telemetry } = setup({
        requirements: [PERF],
        mode: 'implicit',
        store,
      });

      telemetry.event('early', undefined, { category: 'perf' });
      expect(sink.events).toEqual([]); // held despite implicit mode

      resolve({ perf: 'denied' });
      await Promise.resolve();

      expect(sink.events).toEqual([]); // the stored denial won
      telemetry.event('late', undefined, { category: 'perf' });
      expect(sink.events).toEqual([]);
    });

    it('undecided after settle follows the mode: required drops, implicit flows', async () => {
      const { store, resolve } = deferredStore();
      const { sink, telemetry } = setup({ requirements: [PERF], store });

      telemetry.event('held', undefined, { category: 'perf' });
      resolve(null); // nothing stored
      await Promise.resolve();
      expect(sink.events).toEqual([]); // required mode drained the deferral as a drop

      telemetry.decide('perf', true);
      telemetry.event('later', undefined, { category: 'perf' });
      expect(sink.events.map((e) => e.name)).toEqual(['later']);
    });

    it('a decision made mid-hydration releases matching deferred emits immediately', () => {
      const { store } = deferredStore(); // never resolves during this test
      const { sink, telemetry } = setup({
        requirements: [PERF, ANALYTICS],
        store,
      });

      telemetry.event('p', undefined, { category: 'perf' });
      telemetry.event('a', undefined, { category: 'analytics' });
      telemetry.decide('perf', true);

      expect(sink.events.map((e) => e.name)).toEqual(['p']); // perf released early
      expect(sink.events.length).toBe(1); // analytics still deferred
    });

    it('a hung store drains the deferral after hydrationTimeoutMs', () => {
      vi.useFakeTimers();
      try {
        const never: ConsentStore = {
          get: () => new Promise(() => undefined),
          set: () => undefined,
        };
        const { sink, telemetry } = setup({
          requirements: [PERF],
          mode: 'implicit',
          store: never,
          hydrationTimeoutMs: 1000,
        });

        telemetry.event('held', undefined, { category: 'perf' });
        expect(sink.events).toEqual([]);

        vi.advanceTimersByTime(1001);
        expect(sink.events.map((e) => e.name)).toEqual(['held']); // implicit + undecided → flows
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
