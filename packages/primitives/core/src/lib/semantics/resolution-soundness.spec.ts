import fc from 'fast-check';
import {
  POOL,
  RESOLUTIONS,
  applyTo,
  arrow,
  agrees,
  evalAlgebra,
  evalPlain,
  flattenAlgebra,
  hasPending,
  lit,
  param,
  plain,
  runOutcome,
  scanPending,
  spread,
  type Expr,
  type Slot,
} from '@mmstack/primitives/testing';
import { makeExprArbitrary } from './testing/resolution-arbitraries';
import { isSentinel, loading } from './sentinel';

const expr = makeExprArbitrary();

describe('[PROVEN] resolution soundness — agreement on all COMPLETING resolutions, generalized over containers, arrows, call-spread, and the hof family', () => {
  it('a committed non-sentinel result agrees with every COMPLETING resolution; a plain-side throw/leak is permitted only when the syntax contains pending — the absorbed-dependency divergence: pending outranks failures, not answers', () => {
    fc.assert(
      fc.property(expr, (e) => {
        const pending = loading('proof');
        const out = runOutcome(() => evalAlgebra(e, pending, {}));

        if (out.kind === 'leak') {
          expect(hasPending(e)).toBe(true);
          return;
        }

        if (out.kind === 'throw') {
          for (const resolution of RESOLUTIONS) {
            expect(runOutcome(() => evalPlain(e, resolution, {})).kind).toBe(
              'throw',
            );
          }
          return;
        }

        const scan = scanPending(out.value, pending);
        expect(scan.foreign).toBe(false);
        if (scan.found) expect(hasPending(e)).toBe(true);

        if (isSentinel(out.value)) return;

        for (const resolution of RESOLUTIONS) {
          const plainOut = runOutcome(() => evalPlain(e, resolution, {}));
          if (plainOut.kind === 'throw' || plainOut.kind === 'leak') {
            expect(hasPending(e)).toBe(true);
          } else {
            expect(agrees(out.value, plainOut.value, pending)).toBe(true);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('[ORACLE search-receiver] indexOf/lastIndexOf/includes walk the RECEIVER, not just the args — a pending element inside the spec search range that the target could resolve to must propagate, never commit a contradictable -1/false (the escaped soundness bug; random generation is too sparse here to be the standing defense)', () => {
    const pending = loading('search-receiver');
    const arrWith = (slots: readonly Slot[]): Expr => ({ t: 'arr', slots });

    const inRange: Expr[] = [
      {
        t: 'search',
        m: 'indexOf',
        arr: arrWith([plain({ t: 'pending' })]),
        target: lit(1),
      },
      {
        t: 'search',
        m: 'includes',
        arr: arrWith([plain({ t: 'pending' })]),
        target: lit(1),
      },
      {
        t: 'search',
        m: 'lastIndexOf',
        arr: arrWith([plain({ t: 'pending' })]),
        target: lit(1),
      },
    ];
    for (const e of inRange) {
      expect(evalAlgebra(e, pending, {})).toBe(pending);
      const scan = scanPending(evalAlgebra(e, pending, {}), pending);
      expect(scan.foreign).toBe(false);
      for (const resolution of RESOLUTIONS) {
        expect(runOutcome(() => evalPlain(e, resolution, {})).kind).toBe(
          'value',
        );
      }
    }

    const backwardHitsMatchFirst: Expr = {
      t: 'search',
      m: 'lastIndexOf',
      arr: arrWith([plain({ t: 'pending' }), plain(lit(1))]),
      target: lit(1),
    };
    expect(evalAlgebra(backwardHitsMatchFirst, pending, {})).toBe(1);

    const outOfRange: Expr = {
      t: 'search',
      m: 'indexOf',
      arr: arrWith([plain({ t: 'pending' }), plain(lit(1))]),
      target: lit(1),
      from: lit(1),
    };
    expect(evalAlgebra(outOfRange, pending, {})).toBe(1);
  });

  it('[ORACLE coercion-normalization] an arrow inside a container coerced by a binary op agrees across both evaluators — the twin-evaluator toString artifact must stay normalized; it is a harness concern, not semantics', () => {
    const pending = loading('coerce');
    const e: Expr = {
      t: 'bin',
      op: 'add',
      l: lit(0),
      r: { t: 'arr', slots: [plain(arrow(['p'], lit(0)))] },
    };
    const out = runOutcome(() => evalAlgebra(e, pending, {}));
    expect(out.kind).toBe('value');
    if (out.kind !== 'value') return;
    for (const resolution of RESOLUTIONS) {
      const plainOut = runOutcome(() => evalPlain(e, resolution, {}));
      expect(plainOut.kind).toBe('value');
      if (plainOut.kind !== 'value') return;
      expect(agrees(out.value, plainOut.value, pending)).toBe(true);
    }
  });

  it('[ORACLE] computed-key and spread sentinels PROPAGATE the instance — they do not merely leak-eject', () => {
    const pending = loading('c2');
    const computedKey: Expr = {
      t: 'obj',
      props: [{ kind: 'computed', k: { t: 'pending' }, v: lit(1) }],
    };
    expect(evalAlgebra(computedKey, pending, {})).toBe(pending);
    const objSpread: Expr = {
      t: 'obj',
      props: [{ kind: 'spread', e: { t: 'pending' } }],
    };
    expect(evalAlgebra(objSpread, pending, {})).toBe(pending);
    const arrSpread: Expr = { t: 'arr', slots: [spread({ t: 'pending' })] };
    expect(evalAlgebra(arrSpread, pending, {})).toBe(pending);
  });

  it('[ORACLE absorbed-then-discarded] object ToPrimitive is value-independent: a contained sentinel may be legitimately consumed without surfacing', () => {
    const pending = loading('absorbed');
    const e: Expr = {
      t: 'unary',
      op: 'negate',
      e: {
        t: 'obj',
        props: [
          {
            kind: 'static',
            k: 'a',
            v: { t: 'member', k: 'a', o: { t: 'pending' } },
          },
        ],
      },
    };
    expect(Number.isNaN(evalAlgebra(e, pending, {}))).toBe(true);
    expect(runOutcome(() => evalPlain(e, null, {})).kind).toBe('throw');
    expect(runOutcome(() => evalPlain(e, { a: 1 }, {}))).toEqual({
      kind: 'value',
      value: NaN,
    });
  });

  it('[ORACLE] arrows receive sentinels raw and their bodies propagate compositionally', () => {
    const pending = loading('ar5');
    const addOne: Expr = applyTo(
      arrow(['p'], { t: 'bin', op: 'add', l: param('p'), r: lit(1) }),
      plain({ t: 'pending' }),
    );
    expect(evalAlgebra(addOne, pending, {})).toBe(pending);
  });

  it('[ORACLE call-spread] a sentinel spread source propagates the whole call BEFORE invoke; spread-out sentinel elements follow invoke arg-scan', () => {
    const pending = loading('spread');
    expect(
      evalAlgebra(
        { t: 'call', f: 'double', args: [spread({ t: 'pending' })] },
        pending,
        {},
      ),
    ).toBe(pending);
    const holding: Expr = { t: 'arr', slots: [plain({ t: 'pending' })] };
    expect(
      evalAlgebra(
        { t: 'call', f: 'double', args: [spread(holding)] },
        pending,
        {},
      ),
    ).toBe(pending);
    expect(
      evalAlgebra(
        {
          t: 'call',
          f: 'double',
          args: [spread({ t: 'arr', slots: [plain(lit(1))] })],
        },
        pending,
        {},
      ),
    ).toBe(2);
  });

  it('[ORACLE call-spread] an aware arrow called through spread receives flattened sentinel elements raw — an unaware callee propagates instead', () => {
    const pending = loading('spread-aware');
    const holding: Expr = { t: 'arr', slots: [plain({ t: 'pending' })] };
    const ignoring = applyTo(arrow(['p'], lit(1)), spread(holding));
    expect(evalAlgebra(ignoring, pending, {})).toBe(POOL[1]);
    const identity = applyTo(arrow(['p'], param('p')), spread(holding));
    expect(evalAlgebra(identity, pending, {})).toBe(pending);
    expect(
      evalAlgebra(
        { t: 'call', f: 'pick', args: [spread(holding)] },
        pending,
        {},
      ),
    ).toBe(pending);
  });

  it('[ORACLE call-spread precedence] an absorbing callee does NOT shield spread flattening — a broken spread throws (JS order); an absorbing spread source still propagates through the flatten', () => {
    const callee = loading('callee');
    const source = loading('source');
    expect(() =>
      evalAlgebra(applyTo({ t: 'pending' }, spread(lit(0))), callee, {}),
    ).toThrow(TypeError);
    const structural = flattenAlgebra([spread({ t: 'pending' })], source, {});
    expect(structural).toBe(source);
    const valueSlot = flattenAlgebra([plain({ t: 'pending' })], source, {});
    expect(valueSlot).toEqual([source]);
  });

  it('[ORACLE shadowing] an inner arrow param shadows the outer same-named param; different-named inner params leave the outer capture visible', () => {
    const pending = loading('shadow');
    const innerShadows = applyTo(
      arrow(['p'], applyTo(arrow(['p'], param('p')), plain(lit(1)))),
      plain(lit(0)),
    );
    expect(evalAlgebra(innerShadows, pending, {})).toBe(POOL[1]);
    expect(evalPlain(innerShadows, undefined, {})).toBe(POOL[1]);

    const outerCaptured = applyTo(
      arrow(['p'], applyTo(arrow(['q'], param('p')), plain(lit(0)))),
      plain(lit(5)),
    );
    expect(evalAlgebra(outerCaptured, pending, {})).toBe(POOL[5]);
    expect(evalPlain(outerCaptured, undefined, {})).toBe(POOL[5]);

    const secondSlot = applyTo(
      arrow(['p', 'q'], param('q')),
      plain(lit(1)),
      plain(lit(2)),
    );
    expect(evalAlgebra(secondSlot, pending, {})).toBe(POOL[2]);
    expect(evalPlain(secondSlot, undefined, {})).toBe(POOL[2]);
  });

  it('[ORACLE index-consuming] two-param callbacks receive the element index through the shims', () => {
    const pending = loading('index');
    const arr: Expr = { t: 'arr', slots: [plain(lit(4)), plain(lit(5))] };
    const indices: Expr = {
      t: 'hof',
      m: 'map',
      arr,
      cb: arrow(['p', 'q'], param('q')),
    };
    expect(evalAlgebra(indices, pending, {})).toEqual([0, 1]);
    expect(evalPlain(indices, undefined, {})).toEqual([0, 1]);

    const secondIndex: Expr = {
      t: 'hof',
      m: 'findIndex',
      arr,
      cb: arrow(['p', 'q'], {
        t: 'bin',
        op: 'strictEq',
        l: param('q'),
        r: lit(1),
      }),
    };
    expect(evalAlgebra(secondIndex, pending, {})).toBe(1);
    expect(evalPlain(secondIndex, undefined, {})).toBe(1);
  });

  it('[ORACLE reduce-in-language] arrow reducers are aware by construction: a pending accumulator is received raw and recoverable per step', () => {
    const pending = loading('reduce');
    const arr: Expr = {
      t: 'arr',
      slots: [plain(lit(1)), plain({ t: 'pending' }), plain(lit(0))],
    };
    const lastElement: Expr = {
      t: 'hof',
      m: 'reduce',
      arr,
      cb: arrow(['p', 'q'], param('q')),
    };
    expect(evalAlgebra(lastElement, pending, {})).toBe(POOL[0]);
    for (const resolution of RESOLUTIONS) {
      expect(evalPlain(lastElement, resolution, {})).toBe(POOL[0]);
    }

    const keepAccumulator: Expr = {
      t: 'hof',
      m: 'reduce',
      arr: { t: 'arr', slots: [plain(lit(1)), plain(lit(2))] },
      cb: arrow(['p', 'q'], param('p')),
      init: { t: 'pending' },
    };
    expect(evalAlgebra(keepAccumulator, pending, {})).toBe(pending);
  });

  it('[ASSERTED] sentinel-free expressions evaluate identically to plain JS', () => {
    fc.assert(
      fc.property(expr, (e) => {
        fc.pre(!hasPending(e));
        const pending = loading();
        const out = runOutcome(() => evalAlgebra(e, pending, {}));
        const plainOut = runOutcome(() => evalPlain(e, undefined, {}));
        expect(plainOut.kind).toBe(out.kind);
        if (out.kind === 'value' && plainOut.kind === 'value') {
          expect(agrees(out.value, plainOut.value, pending)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
