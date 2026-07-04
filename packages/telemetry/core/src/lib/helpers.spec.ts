import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { TELEMETRY } from './telemetry';
import { TelemetryHandles } from './handles';
import { traced, tracedCallback } from './helpers';
import { tracedSignal } from './traced-signal';
import { type SpanHandle } from './sink';

describe('telemetry-core hook-ins', () => {
  function setup() {
    const sink = memorySink();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sink] })],
    });
    return { sink, telemetry: TestBed.inject(TELEMETRY) };
  }

  describe('correlation (auto trace-id injection)', () => {
    it('injects trace_id/span_id into an event emitted inside a span', () => {
      const { sink, telemetry } = setup();
      telemetry.span('op', () =>
        telemetry.event('clicked', { btn: 'go' }),
      );

      const ev = sink.events.find((e) => e.name === 'clicked')!;
      const sp = sink.spans.find((s) => s.name === 'op')!;
      expect(ev.attrs).toEqual({
        btn: 'go',
        trace_id: sp.ctx.traceId,
        span_id: sp.ctx.spanId,
      });
    });

    it('uses an explicit parent for correlation', () => {
      const { sink, telemetry } = setup();
      const p = telemetry.startSpan('p');
      telemetry.event('e', undefined, { parent: p });
      expect(sink.events[0].attrs).toEqual({
        trace_id: p.ctx.traceId,
        span_id: p.ctx.spanId,
      });
    });

    it('adds no correlation ids outside any span', () => {
      const { sink, telemetry } = setup();
      telemetry.event('e', { a: 1 });
      expect(sink.events[0].attrs).toEqual({ a: 1 });
    });
  });

  describe('traced / tracedCallback', () => {
    it('traced wraps a fn in an ended span, forwards attrs, and returns its value', () => {
      const { sink } = setup();
      const out = TestBed.runInInjectionContext(() =>
        traced('work', () => 42, { attrs: { step: 'a' } }),
      );
      expect(out).toBe(42);
      const span = sink.spans.find((s) => s.name === 'work')!;
      expect(span.attrs).toEqual({ step: 'a' });
      expect(span.ended).toBe(true);
    });

    it('traced records a thrown error and rethrows', () => {
      const { sink } = setup();
      expect(() =>
        TestBed.runInInjectionContext(() =>
          traced('boom', () => {
            throw new Error('x');
          }),
        ),
      ).toThrow('x');
      const span = sink.spans.find((s) => s.name === 'boom')!;
      expect(span.error).toBeInstanceOf(Error);
      expect(span.ended).toBe(true);
    });

    it('tracedCallback spans each invocation and propagates errors', () => {
      const { sink } = setup();
      const handler = TestBed.runInInjectionContext(() =>
        tracedCallback('click', (n: number) => {
          if (n < 0) throw new Error('neg');
          return n + 1;
        }),
      );
      expect(handler(1)).toBe(2);
      expect(handler(2)).toBe(3);
      expect(() => handler(-1)).toThrow('neg');

      const spans = sink.spans.filter((s) => s.name === 'click');
      expect(spans.length).toBe(3);
      expect(spans.every((s) => s.ended)).toBe(true);
      expect(spans[2].error).toBeInstanceOf(Error);
    });
  });

  describe('tracedSignal', () => {
    it('records the active span at write time (causedBy)', () => {
      const { telemetry } = setup();
      const sig = TestBed.runInInjectionContext(() => tracedSignal(0));
      expect(sig.causedBy()).toBeUndefined();

      let inner: SpanHandle | undefined;
      telemetry.span('interaction', (s) => {
        inner = s;
        sig.set(5);
      });

      expect(sig()).toBe(5);
      expect(sig.causedBy()).toBe(inner);
    });

    it('is last-writer-wins, and a write outside any span clears the cause', () => {
      const { telemetry } = setup();
      const sig = TestBed.runInInjectionContext(() => tracedSignal(0));

      let a: SpanHandle | undefined;
      let b: SpanHandle | undefined;
      telemetry.span('a', (s) => {
        a = s;
        sig.set(1);
      });
      expect(sig.causedBy()).toBe(a);

      telemetry.span('b', (s) => {
        b = s;
        sig.update((v) => v + 1); // update() captures identically to set()
      });
      expect(sig.causedBy()).toBe(b);

      sig.set(9);
      expect(sig.causedBy()).toBeUndefined(); // cleared, not sticky
    });

    it('does NOT attribute a post-await write: capture is synchronous-only (§8.2)', async () => {
      const { telemetry } = setup();
      const sig = TestBed.runInInjectionContext(() => tracedSignal(0));

      await telemetry.span('op', async () => {
        await Promise.resolve();
        sig.set(1); // the active-span stack popped synchronously before this runs
      });

      expect(sig()).toBe(1);
      expect(sig.causedBy()).toBeUndefined();
    });

    it('tracks causality outside the reactive graph: no recomputation, no dependency', () => {
      const { telemetry } = setup();
      const sig = TestBed.runInInjectionContext(() => tracedSignal(0));

      let computations = 0;
      const derived = computed(() => {
        computations++;
        return sig();
      });
      expect(derived()).toBe(0);
      expect(computations).toBe(1);

      // Same-value write: the cause updates, but equal values notify nobody.
      let span: SpanHandle | undefined;
      telemetry.span('silent', (s) => {
        span = s;
        sig.set(0);
      });
      expect(derived()).toBe(0);
      expect(computations).toBe(1); // zero recomputations
      expect(sig.causedBy()).toBe(span); // yet the cause advanced

      // The flip side, pinned as documented behavior: causedBy() is not a signal,
      // so a computed over it never recomputes on cause changes alone.
      const cause = computed(() => sig.causedBy());
      expect(cause()).toBe(span);
      telemetry.span('later', () => sig.set(0));
      expect(cause()).toBe(span); // stale by design — read causedBy() directly instead
    });

    it('reads never capture: only writes move the cause', () => {
      const { telemetry } = setup();
      const sig = TestBed.runInInjectionContext(() => tracedSignal(0));

      let a: SpanHandle | undefined;
      telemetry.span('a', (s) => {
        a = s;
        sig.set(1);
      });
      telemetry.span('reader', () => sig()); // read inside another span
      expect(sig.causedBy()).toBe(a);
    });
  });

  describe('TelemetryHandles', () => {
    it('publishes and reads vendor handles reactively', () => {
      TestBed.configureTestingModule({});
      const handles = TestBed.inject(TelemetryHandles);
      expect(handles.get('replay.url')()).toBeUndefined();

      const url = signal('https://replay/abc');
      handles.publish('replay.url', url);
      expect(handles.get<string>('replay.url')()).toBe('https://replay/abc');

      url.set('https://replay/def');
      expect(handles.get<string>('replay.url')()).toBe('https://replay/def');
    });
  });
});
