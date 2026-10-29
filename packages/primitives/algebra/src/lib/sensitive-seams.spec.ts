import {
  DONE,
  error,
  type ErrorMintReport,
  isDone,
  isError,
  isLoading,
  joinAbsorbers,
  loading,
  redact,
  registerCanonical,
  sensitive,
  sensitiveEqual,
  sentinelAware,
  setErrorReporter,
  setSensitiveMode,
  setStrictSentinels,
  unbox,
  unboxAll,
} from '@mmstack/primitives/core';
import {
  conditional,
  invoke,
  member,
  strictBinary,
  strictUnary,
} from './algebra';
import { ARRAY_METHOD_SHIMS, spreadArray, type ApplyFn } from './containers';
import { isLabeled, unlabel } from './sensitive';

// Named witnesses at the real seams, before any random suite: receiver binding, aliasing, host
// mutation, schedules and report order, scan depth, the missing container families, rank, thrown
// objects. Each runs the same program with the mode off and on and compares what erasure promises.

const call: ApplyFn = (target, args) =>
  (target as (...a: unknown[]) => unknown)(...args);
const shim = (name: string) => ARRAY_METHOD_SHIMS[name];

let reports: ErrorMintReport[];

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
  setStrictSentinels(true);
});

afterEach(() => {
  setErrorReporter(undefined);
  setSensitiveMode(false);
  setStrictSentinels(false);
});

/** Runs `program` with the mode off, then on; `declare` is `sensitive` only while on. */
function both<T>(program: (declare: (v: unknown) => unknown) => T): {
  off: T;
  on: T;
} {
  setSensitiveMode(false);
  const off = program((v) => v);
  setSensitiveMode(true);
  const on = program(sensitive);
  return { off, on };
}

describe('sensitive seams', () => {
  describe('call seams', () => {
    it('a labeled target is unlabeled for the call, the receiver binds inside apply, the result is labeled', () => {
      const r = both((declare) => {
        const receiver = declare({
          name: 'Ada',
          greet(this: { name: string }) {
            return this.name;
          },
        });
        const method = member(receiver, (o) => (o as { greet: unknown }).greet);
        let seen: unknown;
        const out = invoke(method, [], (target, args) => {
          seen = target;
          return Reflect.apply(
            target as () => unknown,
            unlabel(receiver),
            args,
          );
        });
        return { out, callable: typeof seen === 'function' };
      });
      expect(r.off).toEqual({ out: 'Ada', callable: true });
      expect(r.on.callable).toBe(true);
      expect(isLabeled(r.on.out)).toBe(true);
      expect(unbox(r.on.out)).toBe('Ada');
    });

    it('two references to one box reach the host as one object, in both modes', () => {
      const r = both((declare) => {
        const one = declare({ k: 1 });
        const view = registerCanonical({ a: declare(1) }, { a: 1 });
        return [
          invoke((a: unknown, b: unknown) => a === b, [one, one], call),
          invoke((a: unknown, b: unknown) => a === b, [view, view], call),
          invoke(
            (a: unknown, b: unknown) => a === b,
            [declare({ k: 1 }), declare({ k: 1 })],
            call,
          ),
        ];
      });
      expect(r.off).toEqual([true, true, false]);
      expect(unboxAll(r.on)).toEqual([true, true, false]);
      expect(r.on.every(isLabeled)).toBe(true);
    });

    it('a whole box hands the host its real inner object: a mutation lands the same in both modes', () => {
      const r = both((declare) => {
        const inner = { k: 1 };
        invoke((o: { k: number }) => (o.k = 2), [declare(inner)], call);
        return inner.k;
      });
      expect(r).toEqual({ off: 2, on: 2 });
    });

    it('a per-field view hands one canonical copy; handing it back maps to the view', () => {
      setSensitiveMode(true);
      const view = registerCanonical(
        { a: sensitive('s'), b: 2 },
        { a: 's', b: 2 },
      );
      let received: unknown;
      const back = invoke((o: unknown) => ((received = o), o), [view], call);
      expect(received).not.toBe(view);
      expect(received).toEqual({ a: 's', b: 2 });
      expect(isLabeled(back)).toBe(true);
      expect(unbox(back)).toBe(view);
    });

    it('a host that serializes a per-field view returns a labeled answer', () => {
      setSensitiveMode(true);
      const view = { a: sensitive('secret'), b: 2 };
      const out = invoke((o: unknown) => JSON.stringify(o), [view], call);
      expect(isLabeled(out)).toBe(true);
      expect(unbox(out)).toBe('{"a":"secret","b":2}');
    });
  });

  describe('schedules and report order', () => {
    const minting = (log: unknown[]) =>
      sentinelAware((a: unknown, b?: unknown) => {
        log.push(unboxAll([a, b]));
        if (unboxAll(a) === 2) return error('two');
        return (unboxAll(a) as number) - ((unboxAll(b) as number) || 0);
      });

    it('toSorted runs every comparison and folds; filter stops at an absorbing verdict; find and search stop', () => {
      const r = both((declare) => {
        const log: unknown[] = [];
        const cb = minting(log);
        const pending = loading();
        const results = [
          shim('toSorted')(declare([3, 1, 2]), [cb], call),
          shim('filter')(declare([1, 2, 3]), [cb], call),
          shim('find')(declare([1, 2, 3]), [cb], call),
          shim('indexOf')(declare([1, pending, 2]), [2], call),
          shim('includes')(declare([1, 2, pending]), [2], call),
        ];
        return {
          log,
          kinds: results.map((x) =>
            isError(unlabel(x))
              ? 'error'
              : isLoading(unlabel(x))
                ? 'loading'
                : unboxAll(x),
          ),
          reports: reports.splice(0).map((rep) => unboxAll(rep.cause)),
          labeled: results.map(isLabeled),
        };
      });
      expect(r.on.log).toEqual(r.off.log);
      expect(r.on.kinds).toEqual(r.off.kinds);
      expect(r.on.reports).toEqual(r.off.reports);
      expect(r.off.kinds).toEqual(['error', 'error', 1, 'loading', true]);
      expect(r.on.labeled).toEqual([true, true, true, true, true]);
    });
  });
  describe('scan depth', () => {
    it('strictBinary joins absorbers at the top level only, as today; a labeled nested array labels the result', () => {
      setStrictSentinels(false);
      const plus = (a: unknown, b: unknown) => `${a}${b}`;
      const r = both((declare) => {
        const nestedPending = strictBinary([loading()], 1, () => 'applied');
        const nestedLabel = strictBinary([declare(1)], 1, plus);
        return { nestedPending, nestedLabel };
      });
      expect(r.off).toEqual({ nestedPending: 'applied', nestedLabel: '11' });
      expect(r.on.nestedPending).toBe('applied');
      expect(isLabeled(r.on.nestedLabel)).toBe(true);
      expect(unbox(r.on.nestedLabel)).toBe('11');
      expect(reports).toEqual([]);
    });

    it('the === precision exclusion: an array holding a box labels an identity answer the model keeps plain', () => {
      setSensitiveMode(true);
      const arr = [sensitive(1)];
      const same = strictBinary(arr, arr, (a, b) => a === b);
      const notSame = strictUnary(arr, (a) => !a);
      expect(isLabeled(same)).toBe(true);
      expect(unbox(same)).toBe(true);
      expect(isLabeled(notSame)).toBe(true);
      expect(unbox(notSame)).toBe(false);
    });
  });

  describe('container families', () => {
    it('reduce, flatMap, findLast, lastIndexOf, flat, concat and spread over a boxed receiver', () => {
      const add = sentinelAware((a: unknown, b: unknown) =>
        strictBinary(a, b, (x, y) => (x as number) + (y as number)),
      );
      const pair = sentinelAware((x: unknown) => [x, x]);
      const odd = sentinelAware((x: unknown) =>
        strictBinary(x, 2, (a, b) => (a as number) % (b as number)),
      );
      const r = both((declare) => {
        const xs = declare([1, 2, 3]);
        return {
          reduce: shim('reduce')(xs, [add], call),
          reduceSeed: shim('reduce')(xs, [add, 10], call),
          flatMap: shim('flatMap')(xs, [pair], call),
          findLast: shim('findLast')(xs, [odd], call),
          lastIndexOf: shim('lastIndexOf')(declare([1, 2, 1]), [1], call),
          flat: shim('flat')([declare([1, [2]]), [declare([3])]], [2], call),
          concat: shim('concat')([0], [declare([1, 2])], call),
          spread: spreadArray(declare([1, 2])),
        };
      });
      expect(r.off).toEqual({
        reduce: 6,
        reduceSeed: 16,
        flatMap: [1, 1, 2, 2, 3, 3],
        findLast: 3,
        lastIndexOf: 2,
        flat: [1, 2, 3],
        concat: [0, 1, 2],
        spread: [1, 2],
      });
      expect(unboxAll(r.on)).toEqual(r.off);
      // `spreadArray` hands boxed elements in a fresh plain array (the engine labels the literal it
      // lands in); every other result here is labeled whole.
      const { spread, ...whole } = r.on;
      for (const [name, value] of Object.entries(whole))
        expect(isLabeled(value), name).toBe(true);
      expect(isLabeled(spread)).toBe(false);
      expect((spread as unknown[]).every(isLabeled)).toBe(true);
    });

    it('callbacks over a boxed receiver receive boxed elements and plain indexes', () => {
      setSensitiveMode(true);
      const seen: unknown[][] = [];
      const spy = sentinelAware(
        (...args: unknown[]) => (seen.push(args), true),
      );
      shim('map')(sensitive([{ id: 1 }, 'x']), [spy], call);
      expect(seen.map(([el, i]) => [isLabeled(el), i])).toEqual([
        [true, 0],
        [true, 1],
      ]);
      expect(unbox(seen[0][0])).toEqual({ id: 1 });
    });

    it('default toSorted over per-field elements keeps the original element objects', () => {
      setSensitiveMode(true);
      const a = [sensitive('b')];
      const b = [sensitive('a')];
      const out = shim('toSorted')([a, b, undefined], [], call);
      expect(isLabeled(out)).toBe(true);
      expect(unbox(out)).toEqual([b, a, undefined]);
      expect((unbox(out) as unknown[])[0]).toBe(b);
    });
  });

  describe('rank and predicates', () => {
    it('a labeled absorber ranks exactly as its plain absorber and outranks nothing', () => {
      setSensitiveMode(true);
      const failed = error('x');
      const pending = loading();
      const twinError = sensitive(failed);
      const twinPending = sensitive(pending);
      expect(joinAbsorbers([twinError, pending])).toBe(pending);
      expect(joinAbsorbers([twinPending, failed])).toBe(twinPending);
      const mixed = strictBinary(twinError, pending, () => 0);
      expect(isLoading(mixed)).toBe(true);
      expect(isLabeled(mixed)).toBe(true);
      expect(unlabel(mixed)).toBe(pending);
      expect(strictBinary(1, pending, () => 0)).toBe(pending);
      expect(
        strictBinary(sensitive(1), 2, (a, b) => (a as number) + (b as number)),
      ).toSatisfy(isLabeled);
    });

    it('isError over a box is a labeled false; over a labeled error a labeled true', () => {
      setSensitiveMode(true);
      const overBox = invoke(isError, [sensitive(0)], call);
      const overTwin = invoke(isError, [sensitive(error('x'))], call);
      expect([isLabeled(overBox), unbox(overBox)]).toEqual([true, false]);
      expect([isLabeled(overTwin), unbox(overTwin)]).toEqual([true, true]);
    });
  });

  describe('thrown under a labeled call', () => {
    it('the thrown object is marked and rethrown as is; its mint is labeled; a primitive passes unmarked', () => {
      setSensitiveMode(true);
      const boom = new Error('host failed');
      let caught: unknown;
      try {
        invoke(
          () => {
            throw boom;
          },
          [sensitive(1)],
          call,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(boom);
      expect(isLabeled(boom)).toBe(true);
      error(caught, 'evaluation');
      expect(reports.at(-1)).toMatchObject({
        origin: 'evaluation',
        sensitive: true,
      });
      expect(unbox(reports.at(-1)?.cause)).toBe(boom);
      let primitive: unknown;
      try {
        member(sensitive({}), () => {
          throw 'plain';
        });
      } catch (e) {
        primitive = e;
      }
      expect(primitive).toBe('plain');
      const unlabeledThrow = new Error('plain');
      expect(() =>
        invoke(
          () => {
            throw unlabeledThrow;
          },
          [1],
          call,
        ),
      ).toThrow(unlabeledThrow);
      expect(isLabeled(unlabeledThrow)).toBe(false);
    });

    it('a branch a labeled test chose runs as a labeled region', () => {
      setSensitiveMode(true);
      const r = invoke(
        sentinelAware((x: unknown) => x),
        [sensitive(true)],
        call,
      );
      expect(isLabeled(r)).toBe(true);
      strictUnary(sensitive(1), () => error('inside'));
      expect(reports.at(-1)?.sensitive).toBe(true);
    });
  });

  describe('paired secrets (two runs that differ only in a boxed boolean)', () => {
    /** Runs `program` for `secret` false and true with the mode on; returns both observations. */
    function pair<T>(program: (secret: unknown) => T): [T, T] {
      setSensitiveMode(true);
      return [program(sensitive(false)), program(sensitive(true))];
    }
    const chosen = (secret: unknown, yes: () => unknown, no: () => unknown) =>
      conditional(secret, yes, no);

    it('flattening a secret-chosen array labels the result whole', () => {
      const flat = pair((s) =>
        redact(
          shim('flat')(
            [
              chosen(
                s,
                () => [1],
                () => [],
              ),
            ],
            [],
            call,
          ),
        ),
      );
      const flatMap = pair((s) =>
        redact(
          shim('flatMap')(
            [0],
            [
              sentinelAware(() =>
                chosen(
                  s,
                  () => [1],
                  () => [],
                ),
              ),
            ],
            call,
          ),
        ),
      );
      expect(flat[0]).toEqual(flat[1]);
      expect(flatMap[0]).toEqual(flatMap[1]);
    });

    it('a secret-chosen target runs its whole call as a labeled region', () => {
      const reportsOf = (s: unknown) => {
        reports.length = 0;
        const target = chosen(
          s,
          () => sentinelAware(() => error('chosen')),
          () => sentinelAware(() => 0),
        );
        invoke(target, [], call);
        shim('map')([0], [target], call);
        return reports.filter((r) => !r.sensitive).length;
      };
      const [off, on] = pair(reportsOf);
      expect(off).toBe(on);
      expect(on).toBe(0);
    });

    it('coercing a labeled absorber answers the placeholder, never its kind', () => {
      setStrictSentinels(false);
      const seen = pair((s) => {
        reports.length = 0;
        const v = chosen(
          s,
          () => loading(),
          () => error('x'),
        );
        return [
          String(v),
          JSON.stringify(v),
          Number(v),
          reports.filter((r) => !r.sensitive).length,
        ];
      });
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0][0]).toBe('[mmstack sensitive]');
      expect(seen[0][1]).toBe('{"$sensitive":true}');
    });

    it('a coercion over a labeled operand throws labeled; an early absorber carries the receiver label', () => {
      setSensitiveMode(true);
      const caught = (run: () => unknown) => {
        try {
          return run();
        } catch (thrown) {
          return error(thrown, 'evaluation');
        }
      };
      reports.length = 0;
      const failed = caught(() =>
        shim('join')(
          [
            chosen(
              sensitive(true),
              () => ({ toString: 0 }),
              () => 0,
            ),
          ],
          [],
          call,
        ),
      );
      expect(isError(unlabel(failed))).toBe(true);
      expect(isLabeled(failed)).toBe(true);
      expect(reports.at(-1)?.sensitive).toBe(true);
      const pending = shim('map')(sensitive([1]), [loading()], call);
      expect(isLoading(pending)).toBe(true);
      expect(isLabeled(pending)).toBe(true);
    });
  });

  describe('settlement, arguments and equality', () => {
    it('a labeled done is a done twin, and isDone answers as in mode off', () => {
      const r = both((declare) =>
        unboxAll(invoke(isDone, [declare(DONE)], call)),
      );
      expect(r).toEqual({ off: true, on: true });
      setSensitiveMode(true);
      const twin = sensitive(DONE);
      expect(isDone(twin)).toBe(true);
      expect(isLabeled(twin)).toBe(true);
      expect(unlabel(twin)).toBe(DONE);
    });

    it('unwrapping never runs a getter, keeps cycles and null prototypes', () => {
      let runs = 0;
      const r = both((declare) => {
        const x = {
          get a(): number {
            runs++;
            throw new Error('getter');
          },
        };
        const viaPlain = invoke(() => 7, [x], call);
        const o: Record<string, unknown> = { secret: declare(1) };
        o['self'] = o;
        const cyclic = invoke(
          (v: { self: unknown }) => v.self === v,
          [o],
          call,
        );
        const loop: unknown[] = [];
        loop.push(loop);
        const absorbed = isLoading(
          unlabel(strictBinary(loop, loading(), () => 0)),
        );
        const bare = Object.assign(Object.create(null) as object, {
          s: declare(1),
        });
        const proto = invoke(
          (v: object) => Object.getPrototypeOf(v),
          [bare],
          call,
        );
        return unboxAll([viaPlain, cyclic, absorbed, proto]);
      });
      expect(r.off).toEqual([7, true, true, null]);
      expect(r.on).toEqual(r.off);
      expect(runs).toBe(0);
    });

    it('default toSorted over one element never coerces it', () => {
      setSensitiveMode(true);
      let coerced = 0;
      const one = { toString: () => (coerced++, 'x') };
      shim('toSorted')(sensitive([one]), [], call);
      shim('toSorted')([sensitive(one)], [], call);
      expect(coerced).toBe(0);
    });

    it('sensitiveEqual differs only where a label differs', () => {
      setSensitiveMode(true);
      const always = sensitiveEqual<unknown>(() => true);
      expect(always([], [1])).toBe(true);
      expect(always({ a: 1 }, { a: 1, b: 2 })).toBe(true);
      expect(always([], [sensitive(1)])).toBe(false);
      expect(always({ a: [sensitive(1)] }, { a: 1 })).toBe(false);
    });
  });

  describe('search start index', () => {
    it('forward and reverse, plain and boxed start, mode on equals mode off', () => {
      const r = both((declare) => [
        shim('indexOf')([1, 2, 1], [1, 1], call),
        shim('indexOf')([1, 2, 1], [1, declare(1)], call),
        shim('includes')([1, 2, 3], [1, 1], call),
        shim('includes')([1, 2, 3], [3, declare(-1)], call),
        shim('lastIndexOf')([1, 2, 1], [1, 1], call),
        shim('lastIndexOf')([1, 2, 1], [1, declare(-2)], call),
        shim('indexOf')(declare([1, 2, 1]), [1, 1], call),
      ]);
      expect(r.off).toEqual([2, 2, false, true, 0, 0, 2]);
      expect(unboxAll(r.on)).toEqual(r.off);
      expect((r.on as unknown[]).map(isLabeled)).toEqual([
        false,
        true,
        false,
        true,
        false,
        true,
        true,
      ]);
    });
  });

  describe('receiver reads and early returns', () => {
    const caught = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (thrown) {
        return error(thrown, 'evaluation');
      }
    };
    /** The caught result is a labeled error and the last report is sensitive. */
    const expectLabeledFailure = (result: unknown, name: string) => {
      expect(isError(unlabel(result)), name).toBe(true);
      expect(isLabeled(result), name).toBe(true);
      expect(reports.at(-1)?.sensitive, name).toBe(true);
    };

    it('every protected coercion throws labeled: start index both ways, flat depth, callback message', () => {
      setSensitiveMode(true);
      const throwing = () =>
        sensitive({
          valueOf() {
            throw new Error('secret coercion');
          },
          toString() {
            throw new Error('secret coercion');
          },
        });
      const paths: ReadonlyArray<readonly [string, () => unknown]> = [
        [
          'indexOf start',
          () => shim('indexOf')([1, 2, 1], [1, throwing()], call),
        ],
        [
          'includes start',
          () => shim('includes')([1, 2, 1], [1, throwing()], call),
        ],
        [
          'lastIndexOf start',
          () => shim('lastIndexOf')([1, 2, 1], [1, throwing()], call),
        ],
        ['flat depth', () => shim('flat')([[1]], [throwing()], call)],
        ['callback message', () => shim('map')([1], [throwing()], call)],
      ];
      for (const [name, run] of paths) {
        reports.length = 0;
        expectLabeledFailure(caught(run), name);
      }
    });

    it('an accessor read out of a boxed receiver runs in the region', () => {
      setSensitiveMode(true);
      const bad: unknown[] = [];
      Object.defineProperty(bad, 0, {
        enumerable: true,
        get() {
          throw new Error('secret read');
        },
      });
      for (const name of ['flat', 'map', 'indexOf', 'toSorted', 'join']) {
        reports.length = 0;
        const args =
          name === 'map'
            ? [sentinelAware((x: unknown) => x)]
            : name === 'indexOf'
              ? [1]
              : [];
        expectLabeledFailure(
          caught(() => shim(name)(sensitive(bad), args, call)),
          name,
        );
      }
      reports.length = 0;
      expectLabeledFailure(
        caught(() => spreadArray(sensitive(bad))),
        'spread',
      );
    });

    it('early returns carry the receiver label: absorbing comparator, absorbing callback', () => {
      setSensitiveMode(true);
      const sorted = shim('toSorted')(sensitive([1]), [loading()], call);
      expect(isLoading(sorted)).toBe(true);
      expect(isLabeled(sorted)).toBe(true);
      const mapped = shim('map')(sensitive([1]), [loading()], call);
      expect(isLabeled(mapped)).toBe(true);
      const empty = caught(() =>
        shim('reduce')(sensitive([]), [sentinelAware(() => 0)], call),
      );
      expect(isLabeled(empty)).toBe(true);
    });

    it('default toSorted over one defined element beside undefined coerces nothing', () => {
      const r = both((declare) => {
        const loud = {
          toString(): string {
            throw new Error('unexpected');
          },
        };
        return unboxAll(shim('toSorted')([declare(loud), undefined], [], call));
      });
      expect((r.off as unknown[]).length).toBe(2);
      expect((r.on as unknown[]).length).toBe(2);
    });
  });

  describe('copy fidelity', () => {
    it('an own __proto__ key stays an own key through unboxAll, redact and a non-aware call', () => {
      const probe = (o: Record<string, unknown>) => [
        Object.hasOwn(o, '__proto__'),
        Object.getPrototypeOf(o) === Object.prototype,
        o['injected'],
      ];
      const make = (declare: (v: unknown) => unknown) =>
        ({ ['__proto__']: { injected: 7 }, secret: declare(1) }) as Record<
          string,
          unknown
        >;
      const r = both((declare) =>
        unboxAll(invoke(probe, [make(declare)], call)),
      );
      expect(r.off).toEqual([true, true, undefined]);
      expect(r.on).toEqual(r.off);
      setSensitiveMode(true);
      for (const read of [unboxAll, redact])
        expect(probe(read(make(sensitive)) as Record<string, unknown>)).toEqual(
          [true, true, undefined],
        );
    });

    it('an array subclass is handed to a non-aware callee as it is', () => {
      class Tagged extends Array<unknown> {}
      const r = both((declare) => {
        const x = new Tagged();
        x.push(declare(1));
        return unboxAll(
          invoke((o: unknown) => o instanceof Tagged && o === x, [x], call),
        );
      });
      expect(r).toEqual({ off: true, on: true });
    });

    it('equality over alternating cyclic partners with no labels defers to the base', () => {
      setSensitiveMode(true);
      const a: Record<string, unknown> = {};
      const x: Record<string, unknown> = {};
      const y: Record<string, unknown> = {};
      a['next'] = a;
      x['next'] = y;
      y['next'] = x;
      expect(sensitiveEqual<unknown>(() => true)(a, x)).toBe(true);
    });
  });
});
