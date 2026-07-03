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

  it('returns null without a client', () => {
    expect(posthogSink({ posthog: null })()).toBeNull();
  });
});
