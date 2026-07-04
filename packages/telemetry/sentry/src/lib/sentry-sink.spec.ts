import { TestBed } from '@angular/core/testing';
import { provideTelemetry, TELEMETRY, TelemetryHandles } from '@mmstack/telemetry-core';
import { SENTRY_LAST_EVENT_ID, sentrySink, type SentryClient } from './sentry-sink';

describe('@mmstack/telemetry-sentry', () => {
  it('captures exceptions with attrs carried as Sentry extra', () => {
    const calls: { err: unknown; hint?: { captureContext?: { extra?: Record<string, unknown> } } }[] = [];
    const sentry: SentryClient = {
      captureException: (err, hint) => {
        calls.push({ err, hint });
        return 'event-id';
      },
    };
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })] });

    const err = new Error('boom');
    TestBed.inject(TELEMETRY).error(err, { where: 'checkout' });

    expect(calls.length).toBe(1);
    expect(calls[0].err).toBe(err);
    expect(calls[0].hint?.captureContext?.extra).toMatchObject({ where: 'checkout' });
  });

  it('publishes a reactive sentry.last_event_id handle that updates per capture', () => {
    let n = 0;
    const sentry: SentryClient = { captureException: () => `evt-${++n}` };
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })] });

    TestBed.inject(TELEMETRY); // triggers sink init → publishes the handle
    const handle = TestBed.inject(TelemetryHandles).get<string>(SENTRY_LAST_EVENT_ID);
    expect(handle()).toBeUndefined();

    TestBed.inject(TELEMETRY).error(new Error('x'));
    expect(handle()).toBe('evt-1');

    TestBed.inject(TELEMETRY).error(new Error('y'));
    expect(handle()).toBe('evt-2');
  });

  it('correlates errors recorded inside a span with the exact span ids in extra', () => {
    const calls: { hint?: { captureContext?: { extra?: Record<string, unknown> } } }[] = [];
    const sentry: SentryClient = {
      captureException: (_err, hint) => {
        calls.push({ hint });
        return 'event-id';
      },
    };
    TestBed.configureTestingModule({ providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })] });

    const t = TestBed.inject(TELEMETRY);
    let ctx: { traceId: string; spanId: string } | undefined;
    t.span('op', (span) => {
      ctx = span.ctx;
      t.error(new Error('boom'));
    });

    expect(calls[0].hint?.captureContext?.extra).toEqual({
      trace_id: ctx!.traceId,
      span_id: ctx!.spanId,
    });
  });

  it('namespaces the event-id handle by sink name so two instances coexist', () => {
    const sentryA: SentryClient = { captureException: () => 'a-1' };
    const sentryB: SentryClient = { captureException: () => 'b-1' };
    TestBed.configureTestingModule({
      providers: [
        provideTelemetry({
          sinks: [sentrySink({ sentry: sentryA }), sentrySink({ sentry: sentryB, name: 'sentry-b' })],
        }),
      ],
    });

    TestBed.inject(TELEMETRY).error(new Error('x'));
    const handles = TestBed.inject(TelemetryHandles);
    expect(handles.get<string>(SENTRY_LAST_EVENT_ID)()).toBe('a-1'); // default key intact
    expect(handles.get<string>('sentry-b.last_event_id')()).toBe('b-1'); // not shadowed
  });

  it('maps identify to Sentry setUser; identify(null) clears the user', () => {
    const users: (({ id: string } & Record<string, unknown>) | null)[] = [];
    const sentry: SentryClient = {
      captureException: () => 'id',
      setUser: (u) => users.push(u),
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
    });
    const t = TestBed.inject(TELEMETRY);
    t.identify('user-1', { email: 'a@b.c' });
    t.identify(null);
    expect(users).toEqual([{ id: 'user-1', email: 'a@b.c' }, null]);
  });

  it('does not advertise identity when the client lacks setUser (safe no-op)', () => {
    const sentry: SentryClient = { captureException: () => 'id' };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
    });
    expect(() => TestBed.inject(TELEMETRY).identify('u1')).not.toThrow();
  });

  it('returns null without a client', () => {
    expect(sentrySink({ sentry: null })()).toBeNull();
  });
});
