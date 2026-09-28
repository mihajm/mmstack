import { TestBed } from '@angular/core/testing';
import { deny, type AttributePolicy } from './attrs';
import { memorySink } from './memory-sink';
import { formatOrigin, type Origin } from './origin';
import { provideTelemetry } from './provide';
import { TELEMETRY } from './telemetry';

const CLICK: Origin = {
  kind: 'interaction',
  name: 'click',
  target: 'button#next',
};
const NAV: Origin = { kind: 'navigation', name: 'route-change' };

const CLICK_ATTRS = {
  'origin.kind': 'interaction',
  'origin.name': 'click',
  'origin.target': 'button#next',
};
const NAV_ATTRS = {
  'origin.kind': 'navigation',
  'origin.name': 'route-change',
};

function setup(policy?: AttributePolicy) {
  const sink = memorySink();
  TestBed.configureTestingModule({
    providers: [provideTelemetry({ sinks: [sink], policy })],
  });
  return { sink, telemetry: TestBed.inject(TELEMETRY) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('origin', () => {
  it('stamps every emit kind made inside withOrigin', () => {
    const { sink, telemetry } = setup();
    telemetry.withOrigin(CLICK, () => {
      telemetry.event('e');
      telemetry.error(new Error('x'));
      telemetry.metric('m', 1);
      telemetry.log('info', 'l');
      telemetry.finding('F', { severity: 'warn', path: 'p', message: 'fix' });
      telemetry.startSpan('manual').end();
      telemetry.span('s', () => undefined);
    });

    expect(sink.events[0].attrs).toEqual(CLICK_ATTRS);
    expect(sink.errors[0].attrs).toEqual(CLICK_ATTRS);
    expect(sink.metrics[0].attrs).toEqual(CLICK_ATTRS);
    expect(sink.logs[0].attrs).toEqual(CLICK_ATTRS);
    expect(sink.findings[0].attrs).toEqual(CLICK_ATTRS);
    expect(sink.spans.map((s) => [s.name, s.attrs])).toEqual([
      ['manual', CLICK_ATTRS],
      ['s', CLICK_ATTRS],
    ]);
  });

  it('omits origin.target when the origin has none, and adds nothing outside withOrigin', () => {
    const { sink, telemetry } = setup();
    telemetry.withOrigin(NAV, () => telemetry.event('inside'));
    telemetry.event('outside');

    expect(sink.events[0].attrs).toEqual(NAV_ATTRS);
    expect(sink.events[1].attrs).toEqual({}); // the policy runs on `attrs ?? {}`
  });

  it('nested withOrigin shadows, and the outer origin is restored on return', () => {
    const { sink, telemetry } = setup();
    const seen: (Origin | undefined)[] = [];
    telemetry.withOrigin(CLICK, () => {
      telemetry.event('outer');
      telemetry.withOrigin(NAV, () => {
        seen.push(telemetry.activeOrigin());
        telemetry.event('inner');
      });
      seen.push(telemetry.activeOrigin());
      telemetry.event('outer-again');
    });
    seen.push(telemetry.activeOrigin());

    expect(seen).toEqual([NAV, CLICK, undefined]);
    expect(sink.events.map((e) => [e.name, e.attrs])).toEqual([
      ['outer', CLICK_ATTRS],
      ['inner', NAV_ATTRS],
      ['outer-again', CLICK_ATTRS],
    ]);
  });

  it('returns the body result and pops on throw', () => {
    const { telemetry } = setup();
    expect(telemetry.withOrigin(CLICK, () => 42)).toBe(42);
    expect(() =>
      telemetry.withOrigin(CLICK, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(telemetry.activeOrigin()).toBeUndefined();
  });

  it('is synchronous only: the returned promise passes through and emits after await carry no origin', async () => {
    const { sink, telemetry } = setup();
    const gate = deferred();
    const body = async () => {
      telemetry.event('before');
      await gate.promise;
      telemetry.event('after');
    };
    let returned: Promise<void> | undefined;
    const result = telemetry.withOrigin(CLICK, () => (returned = body()));
    expect(result).toBe(returned); // untouched, not wrapped
    expect(telemetry.activeOrigin()).toBeUndefined();

    gate.resolve();
    await result;
    expect(sink.events.map((e) => [e.name, e.attrs])).toEqual([
      ['before', CLICK_ATTRS],
      ['after', {}],
    ]);
  });

  it('two overlapping async bodies attribute only their own synchronous emits', async () => {
    const { sink, telemetry } = setup();
    const a = deferred();
    const b = deferred();
    const pa = telemetry.withOrigin(CLICK, async () => {
      telemetry.event('a.sync');
      await a.promise;
      telemetry.event('a.late');
    });
    const pb = telemetry.withOrigin(NAV, async () => {
      telemetry.event('b.sync');
      await b.promise;
      telemetry.event('b.late');
    });
    b.resolve();
    await pb;
    a.resolve();
    await pa;

    expect(sink.events.map((e) => [e.name, e.attrs])).toEqual([
      ['a.sync', CLICK_ATTRS],
      ['b.sync', NAV_ATTRS],
      ['b.late', {}],
      ['a.late', {}],
    ]);
  });

  it('an explicit SpanCallOptions.origin wins over the ambient one for the span only', () => {
    const { sink, telemetry } = setup();
    telemetry.withOrigin(CLICK, () =>
      telemetry.span('s', () => telemetry.event('body'), { origin: NAV }),
    );
    telemetry.startSpan('manual', { origin: NAV }).end();

    expect(sink.spans.map((s) => [s.name, s.attrs])).toEqual([
      ['s', NAV_ATTRS],
      ['manual', NAV_ATTRS],
    ]);
    // the body still sees the ambient origin: the explicit form is not pushed
    expect(sink.events[0].attrs).toMatchObject(CLICK_ATTRS);
  });

  it('precedence: explicit attrs > origin > global attrs', () => {
    const { sink, telemetry } = setup();
    telemetry.setGlobalAttrs({ 'origin.name': 'from-global', g: 1 });
    telemetry.withOrigin(CLICK, () => {
      telemetry.event('e', { 'origin.kind': 'from-caller' });
      telemetry.span('s', () => undefined, {
        attrs: { 'origin.target': 'from-caller' },
      });
    });

    expect(sink.events[0].attrs).toEqual({
      g: 1,
      'origin.kind': 'from-caller',
      'origin.name': 'click',
      'origin.target': 'button#next',
    });
    expect(sink.spans[0].attrs).toEqual({
      g: 1,
      'origin.kind': 'interaction',
      'origin.name': 'click',
      'origin.target': 'from-caller',
    });
  });

  it('origin attrs are merged before the policy runs', () => {
    const { sink, telemetry } = setup(deny(['origin.target']));
    telemetry.withOrigin(CLICK, () => telemetry.event('e'));
    expect(sink.events[0].attrs).toEqual({
      'origin.kind': 'interaction',
      'origin.name': 'click',
    });
  });

  it('noop facade: runs the body, returns its result, has no active origin', () => {
    const telemetry = TestBed.inject(TELEMETRY);
    let inside: Origin | undefined = NAV;
    const out = telemetry.withOrigin(CLICK, () => {
      inside = telemetry.activeOrigin();
      return 'ran';
    });
    expect(out).toBe('ran');
    expect(inside).toBeUndefined();
    expect(() =>
      telemetry.finding('F', { severity: 'info', path: 'p', message: 'm' }),
    ).not.toThrow();
  });

  it.each<[Origin, string]>([
    [
      { kind: 'interaction', name: 'click', target: 'button#next "Next →"' },
      'click on button#next "Next →"',
    ],
    [{ kind: 'interaction', name: 'keydown' }, 'keydown'],
    [
      { kind: 'navigation', name: 'route-change', target: '/users/:id' },
      'navigation route-change → /users/:id',
    ],
    [{ kind: 'navigation', name: 'popstate' }, 'navigation popstate'],
    [{ kind: 'request', name: 'GET /users' }, 'request GET /users'],
    [{ kind: 'action', name: 'save', target: 'order' }, 'action save → order'],
    [{ kind: 'external', name: 'timer' }, 'external timer'],
  ])('formatOrigin(%o) → %s', (origin, label) => {
    expect(formatOrigin(origin)).toBe(label);
  });
});
