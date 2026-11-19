import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';
import { createHlcClock } from './hlc';
import { applyOps } from './op-log';
import {
  createConvergingApply,
  defaultFold,
  keyedArray,
  lww,
  mergeThree,
  OP_PROTO_VERSION,
  opSync,
  positional,
  preserve,
  replace,
  type FoldFn,
  type FoldPolicyEntry,
  type MergeFn,
  type MergePolicyEntry,
  type OpEnvelope,
  type SyncOp,
  type SyncSibling,
} from './op-sync';

const envOf = (ops: SyncOp[], origin: string, p: number): OpEnvelope => ({
  proto: OP_PROTO_VERSION,
  instance: 'g',
  origin,
  writer: 'w-' + origin,
  version: 1,
  hlc: { p, l: 0 },
  policyVersion: 0,
  ops,
});

const combine: MergeFn = (_a, m, t) => [m, t];

const POLICIES: Array<[string, MergePolicyEntry[]]> = [
  ['no policy', []],
  ['lww', [{ path: 'p', merge: lww }]],
  ['replace', [{ path: 'p', merge: replace }]],
  ['preserve', [{ path: 'p', merge: preserve }]],
  ['mergeThree', [{ path: 'p', merge: mergeThree }]],
  ['positional', [{ path: 'p', merge: positional }]],
  [
    'keyedArray',
    [{ path: 'p', merge: keyedArray((x) => (x as { id?: unknown })?.id) }],
  ],
  ['a combining custom merge', [{ path: 'p', merge: combine }]],
];

const valueArb = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.array(fc.record({ id: fc.integer({ min: 0, max: 3 }), n: fc.integer() }), {
    maxLength: 3,
  }),
);
const loneArb = fc.record({
  kind: fc.constantFrom('set', 'delete', 'clear'),
  value: valueArb,
  epoch: fc.integer({ min: 0, max: 3 }),
  p: fc.integer({ min: 2, max: 50 }),
});

describe('the FoldFn law: a fold of one sibling returns that sibling', () => {
  it('defaultFold returns a lone sibling as it is', () => {
    fc.assert(
      fc.property(loneArb, ({ kind, value, epoch, p }) => {
        const s: SyncSibling = {
          kind: kind as SyncSibling['kind'],
          ...(kind === 'set' ? { value } : {}),
          writer: 'w',
          origin: 'o',
          hlc: { p, l: 0 },
          epoch,
        };
        expect(defaultFold([s], { path: ['p'] })).toStrictEqual(
          kind === 'set' ? { kind, value } : { kind },
        );
      }),
    );
  });

  it.each(POLICIES)(
    'PROPERTY: the built-in fold under %s materializes a lone write as written',
    (_name, policies) => {
      fc.assert(
        fc.property(loneArb, ({ kind, value, epoch, p }) => {
          const conv = createConvergingApply({ policies });
          conv.ingest(
            envOf(
              [
                {
                  kind: 'set',
                  path: [],
                  next: { p: 'old', q: 1 },
                  cites: [],
                  epoch: 0,
                },
              ],
              'base',
              1,
            ),
          );
          const op = (
            kind === 'set'
              ? {
                  kind,
                  path: ['p'],
                  next: value,
                  prev: 'old',
                  cites: [],
                  epoch,
                }
              : kind === 'delete'
                ? { kind, path: ['p'], prev: 'old', cites: [], epoch }
                : { kind, path: ['p'], cites: [], epoch }
          ) as SyncOp;
          const root = applyOps(
            { p: 'old', q: 1 },
            conv.ingest(envOf([op], 'writer', p)),
          );
          const expected =
            kind === 'set'
              ? { p: value, q: 1 }
              : kind === 'delete'
                ? { q: 1 }
                : { p: 'old', q: 1 };
          expect(conv.materialize()).toStrictEqual(expected);
          expect(root).toStrictEqual(expected);
        }),
        { numRuns: 60 },
      );
    },
  );
});

describe('the FoldFn law — dev check on plain local writes at custom-fold paths', () => {
  const clamp: FoldFn = (siblings) => {
    const top = Math.max(
      ...siblings.map((s) => (s.kind === 'set' ? (s.value as number) : 0)),
    );
    return { kind: 'set', value: Math.min(100, top) };
  };
  const maxFold: FoldFn = (siblings) => {
    const sets = siblings.filter((s) => s.kind === 'set');
    if (!sets.length) return defaultFold(siblings, { path: [] });
    return {
      kind: 'set',
      value: Math.max(...sets.map((s) => s.value as number)),
    };
  };

  const peer = (folds: FoldPolicyEntry[], origin: string) =>
    TestBed.runInInjectionContext(() => {
      const s = signal<{ n: number; m: number }>({ n: 0, m: 0 });
      const sync = opSync(s, {
        writer: 'w',
        origin,
        folds,
        clock: createHlcClock(() => 1),
      });
      const out: OpEnvelope[] = [];
      sync.subscribe((e) => out.push(e));
      return { s, sync, out };
    });

  it('warns once per path when a custom fold changes a lone local write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = peer([{ path: 'n', fold: clamp }], 'a');
    a.s.set({ n: 500, m: 0 });
    a.sync.flush();
    a.s.set({ n: 600, m: 0 });
    a.sync.flush();
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.filter((m) => m.includes('custom fold at "n"'))).toHaveLength(
      1,
    );
    expect(msgs[0]).toContain('a fold of one sibling must return that sibling');
    warn.mockRestore();
    a.sync.destroy();
  });

  it('stays silent for a fold that obeys the law, for remote envelopes, and at paths without a custom fold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = peer([{ path: 'n', fold: maxFold }], 'a');
    const b = peer([{ path: 'n', fold: clamp }], 'b');
    a.s.set({ n: 500, m: 7 });
    a.sync.flush();
    for (const e of a.out) b.sync.receive(e);
    expect(b.s().n).toBe(100);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    a.sync.destroy();
    b.sync.destroy();
  });
});

describe('custom folds decide their paths', () => {
  const tag =
    (label: string): FoldFn =>
    (siblings, ctx) => {
      const w = defaultFold(siblings, ctx);
      return w.kind === 'set'
        ? {
            kind: 'set',
            value: `${label}:${String(w.value)}:${ctx.path.join('.')}`,
          }
        : w;
    };

  it('string and array forms match, a custom fold beats a policy at the same path, other paths keep the default', () => {
    const conv = createConvergingApply({
      policies: [{ path: ['c'], merge: preserve }],
      folds: [
        { path: 'a.*', fold: tag('A') },
        { path: ['b'], fold: tag('B') },
        { path: ['c'], fold: tag('C') },
      ],
    });
    conv.ingest(
      envOf(
        [
          { kind: 'set', path: ['a', 'x'], next: 1, cites: [], epoch: 0 },
          { kind: 'set', path: ['b'], next: 2, cites: [], epoch: 0 },
          { kind: 'set', path: ['c'], next: 3, cites: [], epoch: 0 },
          { kind: 'set', path: ['d'], next: 4, cites: [], epoch: 0 },
        ],
        'o',
        1,
      ),
    );
    expect(conv.materialize()).toStrictEqual({
      a: { x: 'A:1:a.x' },
      b: 'B:2:b',
      c: 'C:3:c',
      d: 4,
    });
  });

  it('a custom MergeFn gets ctx.path and only same-epoch set siblings, never a delete', () => {
    const seen: Array<{ path: readonly (string | number)[]; theirs: unknown }> =
      [];
    const spy: MergeFn = (_a, mine, theirs, ctx) => {
      seen.push({ path: ctx.path, theirs });
      return `${String(mine)}+${String(theirs)}`;
    };
    const conv = createConvergingApply({
      policies: [{ path: 'r.*', merge: spy }],
    });
    const at = ['r', 'k'];
    conv.ingest(
      envOf(
        [{ kind: 'set', path: at, next: 'x', cites: [], epoch: 1 }],
        'a',
        3,
      ),
    );
    conv.ingest(
      envOf(
        [{ kind: 'set', path: at, next: 'y', cites: [], epoch: 1 }],
        'b',
        4,
      ),
    );
    conv.ingest(
      envOf(
        [{ kind: 'delete', path: at, prev: 'z', cites: [], epoch: 1 }],
        'c',
        2,
      ),
    );
    conv.ingest(
      envOf(
        [{ kind: 'set', path: at, next: 'stale', cites: [], epoch: 0 }],
        'd',
        5,
      ),
    );
    expect(conv.materialize()).toStrictEqual({ r: { k: 'y+x' } });
    expect(seen.at(-1)).toEqual({ path: ['r', 'k'], theirs: 'x' });
    expect(seen.map((s) => s.theirs)).not.toContain(undefined);
    expect(seen.map((s) => s.theirs)).not.toContain('stale');
  });
});
