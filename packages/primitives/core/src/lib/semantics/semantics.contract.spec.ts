import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  errorConstant,
  errorEdge,
  type ErrorMintReport,
  isError,
  isStrictSentinels,
  loading,
  setErrorReporter,
  setStrictSentinels,
} from './sentinel';
import {
  alwaysSensitive,
  isAlwaysSensitive,
  redact,
  registerCanonical,
  runSensitiveRegion,
  sensitive,
  setSensitiveMode,
  setSensitivePolicy,
  unboxAll,
} from './sensitive';
import { sensitiveEqual } from './sensitive-equal';
import {
  joinSensitiveRegistry,
  PLACEHOLDER_MARKER,
  SENSITIVE,
  SensitiveRegistryError,
} from './sensitive-registry';
import { provideStrictSentinels } from './strict-sentinels';

const PLACEHOLDER = '[mmstack sensitive]';

/** An array with holes at the indexes `values` leaves out. */
const sparse = (length: number, values: Record<number, unknown>): unknown[] => {
  const out = new Array<unknown>(length);
  for (const [i, v] of Object.entries(values)) out[Number(i)] = v;
  return out;
};
let reports: ErrorMintReport[];

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
  setSensitiveMode(true);
});

afterEach(() => {
  setErrorReporter(undefined);
  setSensitiveMode(false);
  setStrictSentinels(false);
  setSensitivePolicy({ placeholder: PLACEHOLDER, marker: PLACEHOLDER_MARKER });
});

describe('reader copies keep every own property', () => {
  it('symbol keys and non-enumerable properties of a copied record survive', () => {
    const brand = Symbol.for('brand');
    const src: Record<string | symbol, unknown> = {
      [brand]: 7,
      secret: sensitive('x'),
    };
    Object.defineProperty(src, 'hidden', { value: 'h', enumerable: false });
    for (const out of [unboxAll(src), redact(src)] as Record<
      string | symbol,
      unknown
    >[]) {
      expect(out).not.toBe(src);
      expect(out[brand]).toBe(7);
      expect(Object.getOwnPropertyDescriptor(out, 'hidden')).toEqual({
        value: 'h',
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  });

  it('named properties of a copied array survive', () => {
    const src = Object.assign([sensitive(1)], { total: 3 });
    const out = unboxAll(src) as unknown[] & { total?: number };
    expect([...out]).toEqual([1]);
    expect(out.total).toBe(3);
    expect(out.length).toBe(1);
  });

  it('holes stay holes and readers over sparse arrays do not throw', () => {
    const out = unboxAll(sparse(2, { 1: sensitive(1) })) as unknown[];
    expect(out.length).toBe(2);
    expect(0 in out).toBe(false);
    expect(out[1]).toBe(1);
    expect(0 in (unboxAll(sparse(2, { 1: 1 })) as unknown[])).toBe(false);
    expect(isAlwaysSensitive(sparse(2, { 1: { a: 1 } }))).toBe(false);
  });

  it('a sentinel inside reader input stays that sentinel', () => {
    const s = loading({ a: sensitive(1) });
    expect(unboxAll(s)).toBe(s);
    expect(redact(s)).toBe(s);
    expect((unboxAll([s]) as unknown[])[0]).toBe(s);
  });
});

describe('sensitiveEqual', () => {
  const byId = (a: unknown, b: unknown) =>
    (a as { id?: unknown } | null)?.id === (b as { id?: unknown } | null)?.id;
  const deep = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);

  it('compares boxes, views and labeled twins by what they hold', () => {
    const is = sensitiveEqual(Object.is);
    expect(is(sensitive(1), sensitive(2))).toBe(false);
    expect(is(sensitive(1), sensitive(1))).toBe(true);
    const v1 = registerCanonical({ a: sensitive('s') }, { a: 's' });
    const v2 = registerCanonical({ a: sensitive('t') }, { a: 't' });
    expect(is(v1, v2)).toBe(false);
    expect(is(sensitive(loading()), sensitive(errorEdge()))).toBe(false);
    expect(sensitiveEqual(deep)({ a: sensitive(1) }, { a: sensitive(2) })).toBe(
      false,
    );
    expect(sensitiveEqual(deep)({ a: sensitive(1) }, { a: sensitive(1) })).toBe(
      true,
    );
  });

  it('a lenient base: shape differences without labels defer to the base and never throw', () => {
    const eq = sensitiveEqual(byId);
    expect(eq({ id: 1, meta: null }, { id: 1 })).toBe(true);
    expect(eq({ id: 1, extra: { x: 1 } }, { id: 1 })).toBe(true);
    expect(eq({ id: 1, meta: {} }, { id: 1, meta: null })).toBe(true);
    const x: Record<string, unknown> = { id: 1 };
    x['self'] = x;
    expect(eq(x, { id: 1 })).toBe(true);
    expect(sensitiveEqual((a, b) => a == b)(null, undefined)).toBe(true);
  });

  it('is reflexive over a labeled error minted in a region', () => {
    const e = runSensitiveRegion(() => errorConstant('x'));
    expect(sensitiveEqual(Object.is)(e, e)).toBe(true);
  });
});

describe('the realm registry', () => {
  const key = Symbol.for('@mmstack/primitives.sensitive');

  it('a fresh host mints a record with the mode off and a fixed slot', () => {
    const host: Record<symbol, unknown> = {};
    const minted = joinSensitiveRegistry(host);
    expect(minted.policy.mode).toBe(false);
    expect(() => {
      host[key] = {};
    }).toThrow();
    expect(() => delete host[key]).toThrow();
    expect(joinSensitiveRegistry(host)).toBe(minted);
  });

  it.each<[string, Record<string, unknown>]>([
    ['policy null', { policy: null }],
    ['policy not an object', { policy: 5 }],
    ['counters not an object', { counters: 5 }],
    [
      'policy.mode not boolean',
      { policy: { ...SENSITIVE.policy, mode: 'yes' } },
    ],
    [
      'policy.placeholder not string',
      { policy: { ...SENSITIVE.policy, placeholder: 1 } },
    ],
    ['counters null', { counters: null }],
    [
      'counters.region not number',
      { counters: { ...SENSITIVE.counters, region: 'x' } },
    ],
    [
      'counters.registered not number',
      { counters: { ...SENSITIVE.counters, registered: 'x' } },
    ],
    [
      'counters.alwaysRegion not number',
      { counters: { ...SENSITIVE.counters, alwaysRegion: 'x' } },
    ],
  ])('a foreign record with %s is rejected', (_name, patch) => {
    expect(() =>
      joinSensitiveRegistry({ [key]: { ...SENSITIVE, ...patch } }),
    ).toThrow(SensitiveRegistryError);
  });
});

describe('boxes in coercions and identity', () => {
  it('a number coercion of a box or a labeled twin is NaN, whatever the placeholder', () => {
    setSensitivePolicy({ placeholder: '0', marker: PLACEHOLDER_MARKER });
    expect(Number(sensitive(1))).toBeNaN();
    expect(Number(sensitive(loading()))).toBeNaN();
    expect(String(sensitive(1))).toBe('0');
  });

  it('declaring the same function twice gives the same box', () => {
    const fn = () => 1;
    expect(sensitive(fn)).toBe(sensitive(fn));
    expect(alwaysSensitive(fn)).toBe(alwaysSensitive(fn));
  });
});

describe('with no error reporter installed', () => {
  beforeEach(() => setErrorReporter(undefined));

  it('a box coerces softly to the placeholder', () => {
    expect(String(sensitive(1))).toBe(PLACEHOLDER);
  });

  it('a sensitive mint returns an error sentinel', () => {
    expect(isError(errorEdge(sensitive('x')))).toBe(true);
  });
});

describe('errorConstant', () => {
  it('defaults to an authored author-fault', () => {
    setSensitiveMode(false);
    const e = errorConstant('x');
    expect(e.origin).toBe('authored');
    expect(reports.at(-1)).toMatchObject({
      origin: 'authored',
      subclass: 'author-fault',
    });
  });
});

describe('strict-sentinel providers', () => {
  const env = (strict: boolean) =>
    createEnvironmentInjector(
      [provideStrictSentinels(strict)],
      TestBed.inject(EnvironmentInjector),
    );

  it('after the last provider leaves, setStrictSentinels controls the policy directly', () => {
    const a = env(true);
    expect(isStrictSentinels()).toBe(true);
    a.destroy();
    expect(isStrictSentinels()).toBe(false);
    setStrictSentinels(true);
    expect(isStrictSentinels()).toBe(true);
    setStrictSentinels(false);
    expect(isStrictSentinels()).toBe(false);
  });

  it('closing one provider keeps a live sibling in charge', () => {
    const a = env(true);
    const b = env(false);
    expect(isStrictSentinels()).toBe(false);
    a.destroy();
    setStrictSentinels(true);
    expect(isStrictSentinels()).toBe(false);
    b.destroy();
    expect(isStrictSentinels()).toBe(true);
  });
});
