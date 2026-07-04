import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY, TelemetryHandles } from '@mmstack/telemetry-core';
import { POSTHOG_REPLAY_URL, posthogSink, type PostHogClient } from './posthog-sink';

describe('@mmstack/telemetry-posthog', () => {
  function captureSpy() {
    const captured: { event: string; props?: Record<string, unknown> }[] = [];
    const posthog: PostHogClient = { capture: (event, props) => captured.push({ event, props }) };
    return { captured, posthog };
  }

  it('forwards events to the PostHog client', () => {
    const { captured, posthog } = captureSpy();
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })] });

    TestBed.inject(TELEMETRY).event('checkout', { plan: 'pro' });
    expect(captured).toEqual([{ event: 'checkout', props: { plan: 'pro' } }]);
  });

  it('correlates events emitted inside a span with the exact span ids', () => {
    const { captured, posthog } = captureSpy();
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })] });

    const t = TestBed.inject(TELEMETRY);
    let ctx: { traceId: string; spanId: string } | undefined;
    t.span('op', (span) => {
      ctx = span.ctx;
      t.event('clicked');
    });
    expect(captured[0].props).toEqual({
      trace_id: ctx!.traceId,
      span_id: ctx!.spanId,
    });
  });

  it('namespaces the replay handle by sink name so two instances coexist', () => {
    const posthogA: PostHogClient = { capture: () => undefined, get_session_replay_url: () => 'https://a/replay' };
    const posthogB: PostHogClient = { capture: () => undefined, get_session_replay_url: () => 'https://b/replay' };
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [posthogSink({ posthog: posthogA }), posthogSink({ posthog: posthogB, name: 'ph-b' })],
        }),
      ],
    });

    TestBed.inject(TELEMETRY);
    const handles = TestBed.inject(TelemetryHandles);
    expect(handles.get<string>(POSTHOG_REPLAY_URL)()).toBe('https://a/replay'); // default key intact
    expect(handles.get<string>('ph-b.replay_url')()).toBe('https://b/replay'); // not shadowed
  });

  it('publishes a posthog.replay_url handle, refreshed on capture', () => {
    const session = { url: undefined as string | undefined }; // mutated when recording "starts"
    const posthog: PostHogClient = { capture: () => undefined, get_session_replay_url: () => session.url };
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })] });

    TestBed.inject(TELEMETRY); // triggers sink init → publishes the handle
    const handle = TestBed.inject(TelemetryHandles).get<string>(POSTHOG_REPLAY_URL);
    expect(handle()).toBeUndefined(); // recording not started yet

    session.url = 'https://app.posthog.com/replay/abc';
    TestBed.inject(TELEMETRY).event('clicked'); // capture refreshes the replay url
    expect(handle()).toBe('https://app.posthog.com/replay/abc');
  });

  it('does not publish a replay handle when the client lacks get_session_replay_url', () => {
    const posthog: PostHogClient = { capture: () => undefined };
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })] });

    TestBed.inject(TELEMETRY);
    const handles = TestBed.inject(TelemetryHandles);
    expect(handles.keys()()).not.toContain(POSTHOG_REPLAY_URL);
  });

  it('forwards errors to captureException when the client supports it', () => {
    const errors: { error: unknown; props?: Record<string, unknown> }[] = [];
    const posthog: PostHogClient = {
      capture: () => undefined,
      captureException: (error, props) => errors.push({ error, props }),
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })],
    });

    const boom = new Error('boom');
    TestBed.inject(TELEMETRY).error(boom, { tool: 'etl' });
    expect(errors).toEqual([{ error: boom, props: { tool: 'etl' } }]);
  });

  it('does not advertise ErrorSink (error() no-ops) when the client lacks captureException', () => {
    const { captured, posthog } = captureSpy();
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })],
    });

    // no captureException on the client → error() has nowhere to go here, and must not throw
    expect(() =>
      TestBed.inject(TELEMETRY).error(new Error('ignored')),
    ).not.toThrow();
    expect(captured).toEqual([]); // errors are not smuggled in as events
  });

  it('identifies a user, and identify(null) resets (logout)', () => {
    const calls: string[] = [];
    const posthog: PostHogClient = {
      capture: () => undefined,
      identify: (id, props) => calls.push(`identify:${id}:${JSON.stringify(props)}`),
      reset: () => calls.push('reset'),
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })],
    });
    const t = TestBed.inject(TELEMETRY);
    t.identify('user-1', { plan: 'pro' });
    t.identify(null);
    expect(calls).toEqual(['identify:user-1:{"plan":"pro"}', 'reset']);
  });

  it('maps setGlobalAttrs to session super-properties; undefined unregisters', () => {
    const registered: Record<string, unknown>[] = [];
    const unregistered: string[] = [];
    const posthog: PostHogClient = {
      capture: () => undefined,
      register_for_session: (props) => registered.push(props),
      unregister: (key) => unregistered.push(key),
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })],
    });
    const t = TestBed.inject(TELEMETRY);
    t.setGlobalAttrs({ tool: 'etl', drop: undefined });
    expect(registered).toEqual([{ tool: 'etl' }]);
    expect(unregistered).toEqual(['drop']);
  });

  it('does not advertise identity/super-props when the client lacks them (safe no-op)', () => {
    const { posthog } = captureSpy(); // only capture
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [posthogSink({ posthog })] })],
    });
    const t = TestBed.inject(TELEMETRY);
    expect(() => {
      t.identify('u1');
      t.setGlobalAttrs({ a: 1 });
    }).not.toThrow();
  });

  it('returns null without a client', () => {
    expect(posthogSink({ posthog: null })()).toBeNull();
  });
});
