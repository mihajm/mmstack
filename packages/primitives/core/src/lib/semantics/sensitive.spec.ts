import {
  error,
  errorConstant,
  errorEdge,
  type ErrorMintReport,
  isAbsorbing,
  isError,
  isLoading,
  isSentinel,
  loading,
  setErrorReporter,
  setStrictSentinels,
} from './sentinel';
import {
  isSensitive,
  isSensitiveMode,
  redact,
  registerCanonical,
  runSensitiveRegion,
  sensitive,
  SensitiveLeakError,
  setSensitiveMode,
  setSensitivePolicy,
  unbox,
  unboxAll,
} from './sensitive';
import { sensitiveEqual } from './sensitive-equal';
import {
  joinSensitiveRegistry,
  PLACEHOLDER_MARKER,
  SENSITIVE,
  SensitiveRegistryError,
} from './sensitive-registry';

const PLACEHOLDER = '[mmstack sensitive]';
const TOKEN = 'tok_5f0c9a1e7d3b';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

let reports: ErrorMintReport[];

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
});

afterEach(() => {
  setErrorReporter(undefined);
  setSensitiveMode(false);
  setStrictSentinels(false);
  setSensitivePolicy({ placeholder: PLACEHOLDER, marker: PLACEHOLDER_MARKER });
});

const on = (): void => setSensitiveMode(true);

const COERCIONS: ReadonlyArray<readonly [string, (b: unknown) => unknown]> = [
  ['String()', (b) => String(b)],
  ['template literal', (b) => `${b}`],
  ['string concat', (b) => '' + b],
  ['toString()', (b) => (b as object).toString()],
  ['valueOf()', (b) => (b as { valueOf: () => unknown }).valueOf()],
  ['Number()', (b) => Number(b)],
  ['unary plus', (b) => +(b as number)],
  ['Array join', (b) => [b, 'x'].join(',')],
  ['JSON.stringify', (b) => JSON.stringify(b)],
  ['JSON.stringify nested', (b) => JSON.stringify({ a: [{ b }] })],
  ['inspect protocol', (b) => (b as Record<symbol, () => unknown>)[INSPECT]()],
];

describe('sensitive box', () => {
  describe('one hidden class', () => {
    it('every box is a frozen instance of one class with no own keys and a frozen prototype', () => {
      on();
      const boxes = [
        sensitive(1),
        sensitive('s'),
        sensitive({ a: 1 }),
        sensitive([1]),
        sensitive(null),
      ];
      const proto = Object.getPrototypeOf(boxes[0]);
      for (const b of boxes) {
        expect(isSensitive(b)).toBe(true);
        expect(Object.getPrototypeOf(b)).toBe(proto);
        expect((b as object).constructor).toBe(proto.constructor);
        expect(Reflect.ownKeys(b as object)).toEqual([]);
        expect(Object.isFrozen(b)).toBe(true);
      }
      expect(Object.isFrozen(proto)).toBe(true);
      expect(Object.prototype.toString.call(boxes[0])).toBe(
        '[object Sensitive]',
      );
    });

    it('a box is not a sentinel', () => {
      on();
      const b = sensitive(0);
      expect(isSentinel(b)).toBe(false);
      expect(isAbsorbing(b)).toBe(false);
      expect(isError(b)).toBe(false);
    });
  });

  describe('leak guards', () => {
    it('soft: every coercion answers the placeholder, NaN or the JSON marker and reports once per box', () => {
      on();
      for (const [name, coerce] of COERCIONS) {
        const b = sensitive(TOKEN);
        const before = reports.length;
        const out = coerce(b);
        const text = typeof out === 'number' ? String(out) : (out as string);
        expect(text, name).not.toContain(TOKEN);
        if (typeof out === 'number') expect(out, name).toBeNaN();
        else if (name.startsWith('JSON'))
          expect(out, name).toContain('{"$sensitive":true}');
        else expect(out, name).toContain(PLACEHOLDER);
        expect(reports.length - before, name).toBe(1);
        coerce(b);
        expect(reports.length - before, name).toBe(1);
      }
      for (const r of reports) {
        expect(r.origin).toBe('leak');
        expect(r.subclass).toBe('author-fault');
        expect(r.sensitive).toBe(true);
        expect(r.cause).toBeInstanceOf(SensitiveLeakError);
      }
    });

    it('strict: every coercion throws SensitiveLeakError naming the boundary, never the value', () => {
      on();
      setStrictSentinels(true);
      for (const [name, coerce] of COERCIONS) {
        let thrown: unknown;
        try {
          coerce(sensitive(TOKEN));
        } catch (e) {
          thrown = e;
        }
        expect(thrown, name).toBeInstanceOf(SensitiveLeakError);
        expect(thrown, name).toBeInstanceOf(TypeError);
        const message = (thrown as Error).message;
        expect(message, name).toMatch(
          /^\[mmstack\] sensitive value leaked to a [a-z-]+ boundary$/,
        );
        expect(message, name).not.toContain(TOKEN);
      }
      expect(reports).toEqual([]);
    });

    it('reflection exposes nothing and never reports', () => {
      on();
      const b = sensitive({ ssn: TOKEN }) as object;
      const seen = [
        Object.keys(b),
        Object.entries(b),
        Object.getOwnPropertyDescriptors(b),
        { ...b },
        Object.prototype.toString.call(b),
      ];
      expect(JSON.stringify(seen)).not.toContain(TOKEN);
      expect(reports).toEqual([]);
    });

    it('structured clone gives an empty plain object: the inner value never travels', () => {
      on();
      const b = sensitive({ ssn: TOKEN });
      const clone = structuredClone(b) as object;
      expect(isSensitive(clone)).toBe(false);
      expect(Object.getPrototypeOf(clone)).toBe(Object.prototype);
      expect(clone).toEqual({});
      expect(reports).toEqual([]);
    });
  });

  describe('policy slots', () => {
    it('the placeholder is a policy slot; the redact marker follows it until set', () => {
      on();
      setSensitivePolicy({ placeholder: '<hidden>' });
      expect(String(sensitive(1))).toBe('<hidden>');
      expect(redact([sensitive(1)])).toEqual(['<hidden>']);
      const marker = { sensitive: true, type: 'string' };
      setSensitivePolicy({ marker });
      expect(redact({ a: sensitive('x'), b: 2 })).toEqual({ a: marker, b: 2 });
      expect(String(sensitive(1))).toBe('<hidden>');
    });
  });

  describe('mode off', () => {
    it('is the identity and registers nothing, mints included', () => {
      const before = SENSITIVE.counters.registered;
      const o = { a: 1 };
      const p = loading('src');
      expect(isSensitiveMode()).toBe(false);
      expect(sensitive(1)).toBe(1);
      expect(sensitive(o)).toBe(o);
      expect(sensitive(p)).toBe(p);
      expect(registerCanonical(o, { a: 1 })).toBe(o);
      expect(runSensitiveRegion(() => error('x'))).toSatisfy(isError);
      error(o);
      expect(SENSITIVE.counters.registered).toBe(before);
      expect(reports.every((r) => r.sensitive === false)).toBe(true);
      expect(sensitiveEqual(Object.is)).toBe(Object.is);
    });
  });
  describe('declaring', () => {
    it('one box per object, a box is itself, a primitive gets a fresh box each time', () => {
      on();
      const o = { a: 1 };
      const b = sensitive(o);
      expect(sensitive(o)).toBe(b);
      expect(sensitive(b)).toBe(b);
      expect(unbox(b)).toBe(o);
      expect(sensitive(1)).not.toBe(sensitive(1));
      expect(unbox(sensitive(1))).toBe(1);
      expect(unbox(7)).toBe(7);
    });

    it('a labeled pending is a fresh loading with the same source, memoized, still pending everywhere', () => {
      on();
      const source = { id: 'q' };
      const p = loading(source);
      const twin = sensitive(p);
      expect(twin).not.toBe(p);
      expect(sensitive(p)).toBe(twin);
      expect(sensitive(twin)).toBe(twin);
      expect(isLoading(twin)).toBe(true);
      expect(isAbsorbing(twin)).toBe(true);
      expect((twin as { source: unknown }).source).toBe(source);
      expect(unbox(twin)).toBe(p);
      expect(isSensitive(twin)).toBe(false);
    });

    it('a labeled error is a copy with the same origin and message and no report', () => {
      on();
      const e = errorConstant('Bad input', 'evaluation');
      const before = reports.length;
      const twin = sensitive(e);
      expect(reports.length).toBe(before);
      expect(isError(twin)).toBe(true);
      expect(twin).toMatchObject({
        origin: 'evaluation',
        renderableMessage: 'Bad input',
      });
      expect(unbox(twin)).toBe(e);
      expect(redact(twin)).toBe(PLACEHOLDER);
      expect(redact(e)).toBe(e);
    });
  });

  describe('labeled mints', () => {
    it('inside a region: reported with the flag and a boxed cause, and labeled', () => {
      on();
      const e = runSensitiveRegion(() => error(TOKEN));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        origin: 'authored',
        subclass: 'author-fault',
        sensitive: true,
      });
      expect(isSensitive(reports[0].cause)).toBe(true);
      expect(unbox(reports[0].cause)).toBe(TOKEN);
      expect(JSON.stringify(redact(reports[0]))).not.toContain(TOKEN);
      expect(redact(e)).toBe(PLACEHOLDER);
    });

    it('over a boxed cause: hidden only; the error stays plain and the same box is reported', () => {
      on();
      const cause = sensitive({ body: TOKEN });
      const e = errorEdge(cause);
      expect(reports[0]).toMatchObject({
        origin: 'edge',
        subclass: 'external-fault',
        sensitive: true,
      });
      expect(reports[0].cause).toBe(cause);
      expect(isError(e)).toBe(true);
      expect(redact(e)).toBe(e);
    });

    it('over an object thrown under a labeled call: labeled, its cause boxed', () => {
      on();
      const thrown = new Error(TOKEN);
      SENSITIVE.labels.add(thrown);
      const e = error(thrown, 'evaluation');
      expect(reports[0]).toMatchObject({
        origin: 'evaluation',
        sensitive: true,
      });
      expect(isSensitive(reports[0].cause)).toBe(true);
      expect(unbox(reports[0].cause)).toBe(thrown);
      expect(redact(e)).toBe(PLACEHOLDER);
    });

    it('a plain mint with the mode on is unlabeled and reports its cause as is', () => {
      on();
      const e = error('plain');
      expect(reports).toEqual([
        {
          origin: 'authored',
          subclass: 'author-fault',
          cause: 'plain',
          sensitive: false,
        },
      ]);
      expect(redact(e)).toBe(e);
    });

    it('a region closes when its function throws', () => {
      on();
      expect(() =>
        runSensitiveRegion(() => {
          throw new Error('inside');
        }),
      ).toThrow('inside');
      error('after');
      expect(reports.at(-1)?.sensitive).toBe(false);
      expect(SENSITIVE.counters.region).toBe(0);
    });
  });

  describe('reader operations', () => {
    it('unboxAll removes every box deep and copies only what held one', () => {
      on();
      const inner = { k: 1 };
      const untouched = [1, 2];
      const value = {
        a: [sensitive(1), { b: sensitive(inner) }],
        c: untouched,
        d: sensitive(loading()),
      };
      const out = unboxAll(value) as Record<string, unknown>;
      expect(out).toEqual({
        a: [1, { b: inner }],
        c: [1, 2],
        d: expect.anything(),
      });
      expect(out['c']).toBe(untouched);
      expect((out['a'] as unknown[])[1]).toEqual({ b: inner });
      expect(((out['a'] as unknown[])[1] as { b: unknown }).b).toBe(inner);
      expect(isLoading(out['d'])).toBe(true);
      expect(redact(out['d'])).toBe(out['d']);
      expect(unboxAll(untouched)).toBe(untouched);
    });

    it('nested boxes are kept by sensitive() and removed by unboxAll()', () => {
      on();
      const nested = sensitive([sensitive(1), 2]);
      expect(isSensitive((unbox(nested) as unknown[])[0])).toBe(true);
      expect(unboxAll(nested)).toEqual([1, 2]);
    });

    it('redact replaces every labeled value with the marker, deep', () => {
      on();
      const value = {
        a: sensitive(TOKEN),
        b: [1, sensitive([TOKEN])],
        c: 'ok',
      };
      expect(redact(value)).toEqual({
        a: PLACEHOLDER,
        b: [1, PLACEHOLDER],
        c: 'ok',
      });
    });
  });

  describe('one walk discipline for readers and equality', () => {
    const graph = () => {
      let runs = 0;
      const record: Record<string, unknown> = { secret: sensitive(TOKEN) };
      Object.defineProperty(record, 'computed', {
        enumerable: true,
        get: () => {
          runs++;
          throw new Error('getter');
        },
      });
      record['self'] = record;
      return { record, runs: () => runs };
    };

    it('unboxAll and redact never run a getter and keep a cyclic alias in the copy', () => {
      on();
      for (const read of [unboxAll, redact]) {
        const { record, runs } = graph();
        const out = read(record) as Record<string, unknown>;
        // Identity checks as booleans: a matcher would print the record and run its getter.
        expect(out === record).toBe(false);
        expect(out['self'] === out).toBe(true);
        expect(
          Object.getOwnPropertyDescriptor(out, 'computed')?.get,
        ).toBeTypeOf('function');
        expect(runs()).toBe(0);
      }
      const { record } = graph();
      expect((unboxAll(record) as Record<string, unknown>)['secret']).toBe(
        TOKEN,
      );
      expect((redact(record) as Record<string, unknown>)['secret']).toBe(
        PLACEHOLDER,
      );
    });

    it('unboxAll keeps a null prototype and does not descend class instances', () => {
      on();
      class Holder {
        constructor(readonly value: unknown) {}
      }
      const held = new Holder(sensitive(1));
      const bare = Object.assign(Object.create(null) as object, {
        s: sensitive(1),
        held,
      });
      const out = unboxAll(bare) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).toBe(null);
      expect(out['s']).toBe(1);
      expect(out['held']).toBe(held);
    });

    it('sensitiveEqual never runs a getter', () => {
      on();
      const eq = sensitiveEqual<unknown>(
        (a, b) => a !== undefined && b !== undefined,
      );
      const { record, runs } = graph();
      expect(eq(record, record)).toBe(true);
      expect(runs()).toBe(0);
    });
  });

  describe('sensitiveEqual', () => {
    it('compares canonical values and the label tree', () => {
      on();
      const eq = sensitiveEqual<unknown>(Object.is);
      expect(eq(sensitive(1), sensitive(1))).toBe(true);
      expect(eq(sensitive(1), 1)).toBe(false);
      expect(eq(1, 1)).toBe(true);
      const held = { a: sensitive(1) };
      expect(eq(held, held)).toBe(true);
      const p = loading();
      expect(eq(sensitive(p), sensitive(p))).toBe(true);
      expect(eq(sensitive(p), p)).toBe(false);
    });

    it('per-field views of one raw value are equal; a view and its raw value are not (labels differ)', () => {
      on();
      const eq = sensitiveEqual<unknown>(Object.is);
      const raw = { a: 1, b: 2 };
      const view = (): object =>
        registerCanonical({ a: sensitive(1), b: sensitive(2) }, raw);
      expect(eq(view(), view())).toBe(true);
      expect(eq(view(), raw)).toBe(false);
    });

    it('the label tree is deep: the same record with one field boxed is a change', () => {
      on();
      const eq = sensitiveEqual<unknown>(
        (a, b) => JSON.stringify(a) === JSON.stringify(b),
      );
      expect(eq({ a: 1, b: [2] }, { a: 1, b: [2] })).toBe(true);
      expect(eq({ a: 1, b: [2] }, { a: 1, b: [sensitive(2)] })).toBe(false);
    });
  });

  describe('registry', () => {
    it('joins an existing slot and rejects a protocol mismatch or a malformed record loudly', () => {
      const key = Symbol.for('@mmstack/primitives.sensitive');
      expect(joinSensitiveRegistry()).toBe(SENSITIVE);
      expect(() => joinSensitiveRegistry({ [key]: { protocol: 99 } })).toThrow(
        SensitiveRegistryError,
      );
      expect(() =>
        joinSensitiveRegistry({ [key]: { ...SENSITIVE, labels: {} } }),
      ).toThrow('malformed');
      expect(() => joinSensitiveRegistry({ [key]: 5 })).toThrow('non-registry');
      const fresh: Record<symbol, unknown> = {};
      const minted = joinSensitiveRegistry(fresh);
      expect(joinSensitiveRegistry(fresh)).toBe(minted);
      expect(Object.isFrozen(minted)).toBe(true);
    });
  });
});
