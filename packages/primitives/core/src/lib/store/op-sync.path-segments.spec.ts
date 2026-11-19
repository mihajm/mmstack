import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';
import {
  createConvergingApply,
  OP_PROTO_VERSION,
  opSync,
  validateEnvelope,
  type OpEnvelope,
} from './op-sync';

type Seg = unknown;

const envAt = (path: readonly Seg[], origin = 'o1', p = 5): OpEnvelope =>
  ({
    proto: OP_PROTO_VERSION,
    instance: 'g',
    origin,
    writer: 'w',
    version: 1,
    hlc: { p, l: 0 },
    policyVersion: 0,
    ops: [{ kind: 'set', path, next: 1, cites: [], epoch: 0 }],
  }) as unknown as OpEnvelope;

// written from the rule, not from validateEnvelope: a segment is a clean non-empty string that is
// not `__proto__`, or a non-negative integer
const admitted = (seg: Seg): boolean => {
  if (typeof seg === 'number') return Number.isInteger(seg) && seg >= 0;
  if (typeof seg !== 'string' || seg.length === 0 || seg === '__proto__')
    return false;
  for (const ch of seg) if (ch.codePointAt(0)! < 0x20) return false;
  return true;
};

const segArb: fc.Arbitrary<Seg> = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.constantFrom('__proto__', '\u001f', 'a\u001fb', '', 'x', '0'),
  fc.integer({ min: -3, max: 40 }),
  fc.double(),
  fc.constant(null),
  fc.boolean(),
  fc.array(fc.constantFrom('__proto__', 'a\u001fb', 'x'), { maxLength: 2 }),
  fc.dictionary(fc.constantFrom('k', 'x'), fc.integer(), { maxKeys: 1 }),
);

describe('validateEnvelope — path segments', () => {
  it('PROPERTY: admits a path exactly when every segment is a clean string or a non-negative integer', () => {
    fc.assert(
      fc.property(fc.array(segArb, { minLength: 1, maxLength: 3 }), (path) => {
        const verdict = validateEnvelope(envAt(path));
        if (path.every(admitted)) expect(verdict).toBeNull();
        else expect(verdict).not.toBeNull();
      }),
      { numRuns: 400 },
    );
  });

  it('PROPERTY: two admitted paths that name different keys never share a register', () => {
    const asKeys = (p: readonly Seg[]) => p.map(String);
    fc.assert(
      fc.property(
        fc.array(segArb, { minLength: 1, maxLength: 3 }),
        fc.array(segArb, { minLength: 1, maxLength: 3 }),
        (p, q) => {
          fc.pre(validateEnvelope(envAt(p)) === null);
          fc.pre(validateEnvelope(envAt(q)) === null);
          fc.pre(JSON.stringify(asKeys(p)) !== JSON.stringify(asKeys(q)));
          const conv = createConvergingApply();
          conv.ingest(envAt(p, 'o1', 5));
          conv.ingest(envAt(q, 'o2', 6));
          expect(
            conv.liveAt(p as (string | number)[]).map((s) => s.origin),
          ).toEqual(['o1']);
          expect(
            conv.liveAt(q as (string | number)[]).map((s) => s.origin),
          ).toEqual(['o2']);
        },
      ),
      { numRuns: 300 },
    );
  });

  const receiveOne = (path: readonly Seg[]) =>
    TestBed.runInInjectionContext(() => {
      const s = signal<{ user: { name: string }; a: { b: number } }>({
        user: { name: 'ann' },
        a: { b: 1 },
      });
      const rejects: string[] = [];
      const sync = opSync(s, {
        writer: 'w',
        onReject: (_e, reason) => rejects.push(reason),
      });
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      sync.receive({
        ...envAt(path, 'remote', 9),
        ops: [
          { kind: 'set', path, next: { isAdmin: true }, cites: [], epoch: 0 },
        ],
      } as unknown as OpEnvelope);
      warn.mockRestore();
      const out = { value: s(), rejects };
      sync.destroy();
      return out;
    });

  it('an array segment that stringifies to __proto__ is rejected and never swaps a prototype', () => {
    const { value, rejects } = receiveOne(['user', ['__proto__']]);
    expect(rejects).toEqual(['path']);
    expect(Object.getPrototypeOf(value.user)).toBe(Object.prototype);
    expect((value.user as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(value).toStrictEqual({ user: { name: 'ann' }, a: { b: 1 } });
  });

  it('an array segment that stringifies across the separator is rejected and never lands at a.b', () => {
    const { value, rejects } = receiveOne([['a\u001fb']]);
    expect(rejects).toEqual(['path']);
    expect(value).toStrictEqual({ user: { name: 'ann' }, a: { b: 1 } });
  });

  it('an integer index segment is still accepted end to end', () => {
    const { rejects } = receiveOne(['a', 0]);
    expect(rejects).toEqual([]);
  });
});
