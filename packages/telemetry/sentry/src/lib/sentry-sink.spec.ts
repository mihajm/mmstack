import { TestBed } from '@angular/core/testing';
import {
  allowOnly,
  provideTelemetry,
  TELEMETRY,
  TelemetryHandles,
  type AttributePolicy,
} from '@mmstack/telemetry-core';
import {
  SENTRY_LAST_EVENT_ID,
  sentrySink,
  type SentryClient,
} from './sentry-sink';

describe('@mmstack/telemetry-sentry', () => {
  it('captures exceptions with attrs carried as Sentry extra', () => {
    const calls: {
      err: unknown;
      hint?: { captureContext?: { extra?: Record<string, unknown> } };
    }[] = [];
    const sentry: SentryClient = {
      captureException: (err, hint) => {
        calls.push({ err, hint });
        return 'event-id';
      },
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
    });

    const err = new Error('boom');
    TestBed.inject(TELEMETRY).error(err, { where: 'checkout' });

    expect(calls.length).toBe(1);
    expect(calls[0].err).toBe(err);
    expect(calls[0].hint?.captureContext?.extra).toMatchObject({
      where: 'checkout',
    });
  });

  it('publishes a reactive sentry.last_event_id handle that updates per capture', () => {
    let n = 0;
    const sentry: SentryClient = { captureException: () => `evt-${++n}` };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
    });

    TestBed.inject(TELEMETRY); // triggers sink init → publishes the handle
    const handle =
      TestBed.inject(TelemetryHandles).get<string>(SENTRY_LAST_EVENT_ID);
    expect(handle()).toBeUndefined();

    TestBed.inject(TELEMETRY).error(new Error('x'));
    expect(handle()).toBe('evt-1');

    TestBed.inject(TELEMETRY).error(new Error('y'));
    expect(handle()).toBe('evt-2');
  });

  it('correlates errors recorded inside a span with the exact span ids in extra', () => {
    const calls: {
      hint?: { captureContext?: { extra?: Record<string, unknown> } };
    }[] = [];
    const sentry: SentryClient = {
      captureException: (_err, hint) => {
        calls.push({ hint });
        return 'event-id';
      },
    };
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
    });

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
          sinks: [
            sentrySink({ sentry: sentryA }),
            sentrySink({ sentry: sentryB, name: 'sentry-b' }),
          ],
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

  describe('findings', () => {
    type Ctx = NonNullable<
      Parameters<NonNullable<SentryClient['captureMessage']>>[1]
    >;

    function setup(policy?: AttributePolicy) {
      const calls: { message: string; ctx?: Ctx }[] = [];
      let n = 0;
      const sentry: SentryClient = {
        captureException: () => 'exception-id',
        captureMessage: (message, ctx) => {
          calls.push({ message, ctx });
          return `msg-${++n}`;
        },
      };
      TestBed.configureTestingModule({
        providers: [
          provideTelemetry({ sinks: [sentrySink({ sentry })], policy }),
        ],
      });
      return { calls, t: TestBed.inject(TELEMETRY) };
    }

    it.each([
      ['info', 'info'],
      ['warn', 'warning'],
      ['error', 'error'],
    ] as const)('maps severity %s to Sentry level %s', (severity, level) => {
      const { calls, t } = setup();
      t.finding('x.code', { severity, path: 'a.b', message: 'fix it' });
      expect(calls.length).toBe(1);
      expect(calls[0].ctx?.level).toBe(level);
      expect(calls[0].ctx?.tags?.['finding.severity']).toBe(severity);
    });

    it('sends the flat capture context: message, fingerprint, tags and extra', () => {
      const { calls, t } = setup();
      t.finding('form.missing-label', {
        severity: 'warn',
        path: 'pages.home',
        node: 'input-3',
        message: 'Add a label',
        data: { count: 2 },
      });
      expect(calls).toEqual([
        {
          message: 'form.missing-label: Add a label',
          ctx: {
            level: 'warning',
            fingerprint: ['form.missing-label|pages.home|input-3'],
            extra: { count: 2 },
            tags: {
              'finding.code': 'form.missing-label',
              'finding.severity': 'warn',
              'finding.path': 'pages.home',
              'finding.node': 'input-3',
            },
          },
        },
      ]);
    });

    it('omits the node tag when the finding has no node', () => {
      const { calls, t } = setup();
      t.finding('c', { severity: 'info', path: 'p', message: 'm' });
      expect(calls[0].ctx?.fingerprint).toEqual(['c|p|']);
      expect(calls[0].ctx?.tags).toEqual({
        'finding.code': 'c',
        'finding.severity': 'info',
        'finding.path': 'p',
      });
      expect(calls[0].ctx?.tags).not.toHaveProperty('finding.node');
    });

    it('carries the policy-applied attrs as extra, not the raw finding data', () => {
      const { calls, t } = setup(allowOnly(['keep']));
      t.finding('c', {
        severity: 'error',
        path: 'p',
        message: 'm',
        data: { keep: 1, secret: 'x' },
      });
      expect(calls[0].ctx?.extra).toEqual({ keep: 1 });
    });

    it('groups recurrences under one fingerprint', () => {
      const { calls, t } = setup();
      t.finding('c', {
        severity: 'warn',
        path: 'p',
        node: 'n',
        message: 'first',
      });
      t.finding('c', {
        severity: 'warn',
        path: 'p',
        node: 'n',
        message: 'second',
      });
      expect(calls.map((c) => c.ctx?.fingerprint)).toEqual([
        ['c|p|n'],
        ['c|p|n'],
      ]);
    });

    it('publishes the returned event id on the last-event-id handle', () => {
      const { t } = setup();
      const handle =
        TestBed.inject(TelemetryHandles).get<string>(SENTRY_LAST_EVENT_ID);
      expect(handle()).toBeUndefined();
      t.finding('c', { severity: 'info', path: 'p', message: 'm' });
      expect(handle()).toBe('msg-1');
      t.finding('c', { severity: 'info', path: 'q', message: 'm' });
      expect(handle()).toBe('msg-2');
    });

    it('does not implement FindingSink when the client lacks captureMessage', () => {
      const captured: unknown[] = [];
      const sentry: SentryClient = {
        captureException: (err) => {
          captured.push(err);
          return 'id';
        },
      };
      const sink = TestBed.runInInjectionContext(() =>
        sentrySink({ sentry })(),
      );
      expect(sink).not.toBeNull();
      expect(sink).not.toHaveProperty('recordFinding');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [provideTelemetry({ sinks: [sentrySink({ sentry })] })],
      });
      const t = TestBed.inject(TELEMETRY);
      expect(() =>
        t.finding('c', { severity: 'error', path: 'p', message: 'm' }),
      ).not.toThrow();
      expect(captured).toEqual([]); // not rerouted to captureException
    });
  });
});
