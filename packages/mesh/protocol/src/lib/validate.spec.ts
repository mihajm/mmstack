import { describe, expect, it } from 'vitest';
import { validateEnvelope } from './validate';
import { MESH_PROTO_VERSION, type OpEnvelope, type SyncOp } from './wire';

const op = (over: Record<string, unknown> = {}): SyncOp =>
  ({
    kind: 'set',
    path: ['a'],
    next: 1,
    cites: [],
    epoch: 0,
    ...over,
  }) as SyncOp;

const base = (over: Record<string, unknown> = {}): OpEnvelope =>
  ({
    proto: MESH_PROTO_VERSION,
    instance: 'g1',
    origin: 'o1',
    writer: 'w1',
    version: 1,
    hlc: { p: 5, l: 0 },
    policyVersion: 0,
    ops: [op()],
    ...over,
  }) as OpEnvelope;

const withOp = (over: Record<string, unknown>): OpEnvelope =>
  base({ ops: [op(over)] });

const validate = (env: unknown) => validateEnvelope(env as OpEnvelope);

// The reason codes are a stable public surface: an adapter reads them from
// `PolicyViolation.detail`, and the client twin in primitives returns the same code.
describe('validateEnvelope: the reason for each malformed shape', () => {
  const rows: [string, unknown, string][] = [
    ['null envelope', null, 'envelope'],
    ['a number for an envelope', 5, 'envelope'],
    ['missing instance', base({ instance: undefined }), 'instance'],
    [
      'a control character in the instance',
      base({ instance: 'g\u0001' }),
      'instance',
    ],
    ['empty origin', base({ origin: '' }), 'origin'],
    [
      'a control character in the origin',
      base({ origin: 'o\u0000' }),
      'origin',
    ],
    [
      'a control character in the writer',
      base({ writer: 'w\u001f' }),
      'writer',
    ],
    ['empty writer', base({ writer: '' }), 'writer'],
    ['NaN physical time', base({ hlc: { p: NaN, l: 0 } }), 'hlc'],
    ['infinite logical counter', base({ hlc: { p: 1, l: Infinity } }), 'hlc'],
    ['null hlc', base({ hlc: null }), 'hlc'],
    ['missing hlc', base({ hlc: undefined }), 'hlc'],
    ['version 0', base({ version: 0 }), 'version'],
    ['version -1', base({ version: -1 }), 'version'],
    ['version 2.5', base({ version: 2.5 }), 'version'],
    ['missing ops', base({ ops: undefined }), 'ops'],
    ['an object for ops', base({ ops: { 0: op() } }), 'ops'],
    ['a null op', base({ ops: [null] }), 'op'],
    ['an unknown op kind', withOp({ kind: 'weird' }), 'kind'],
    ['a string for a path', withOp({ path: 'nope' }), 'path'],
    ['missing path', withOp({ path: undefined }), 'path'],
    ['an empty segment', withOp({ path: ['x', ''] }), 'path-empty'],
    [
      'a control character in a segment',
      withOp({ path: ['x\u001fy'] }),
      'path-control',
    ],
    [
      'a __proto__ segment',
      withOp({ path: ['cfg', '__proto__'] }),
      'path-proto',
    ],
    ['a root delete', withOp({ kind: 'delete', path: [] }), 'root-op'],
    ['a root clear', withOp({ kind: 'clear', path: [] }), 'root-op'],
    ['epoch -1', withOp({ epoch: -1 }), 'epoch'],
    ['epoch NaN', withOp({ epoch: NaN }), 'epoch'],
    ['missing epoch', withOp({ epoch: undefined }), 'epoch'],
    ['missing cites', withOp({ cites: undefined }), 'cites'],
    ['an object for cites', withOp({ cites: {} }), 'cites'],
    ['a null cite', withOp({ cites: [null] }), 'cites'],
    [
      'a cite with an empty origin',
      withOp({ cites: [{ origin: '', hlc: { p: 1, l: 0 } }] }),
      'cites',
    ],
    [
      'a cite with a NaN stamp',
      withOp({ cites: [{ origin: 'o2', hlc: { p: NaN, l: 0 } }] }),
      'cites',
    ],
    [
      'a cite with a null stamp',
      withOp({ cites: [{ origin: 'o2', hlc: null }] }),
      'cites',
    ],
    ['two ops on one path', base({ ops: [op(), op({ next: 2 })] }), 'dup-path'],
    [
      'two ops on one numeric path',
      base({ ops: [op({ path: ['a', 0] }), op({ path: ['a', '0'] })] }),
      'dup-path',
    ],
  ];

  it.each(rows)('%s', (_, env, reason) => {
    expect(validate(env)).toBe(reason);
  });

  it('is total: no input throws', () => {
    for (const [, env] of rows) expect(() => validate(env)).not.toThrow();
  });
});

describe('validateEnvelope: path segments are property keys', () => {
  const bad: [string, unknown][] = [
    ['an array segment that joins to two segments', ['a\u001fb']],
    ['an array segment holding __proto__', ['__proto__']],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', { k: 1 }],
    ['a negative integer', -1],
    ['a fraction', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ];
  it.each(bad)('rejects %s with "path"', (_, seg) => {
    expect(validate(withOp({ path: [seg] }))).toBe('path');
    expect(validate(withOp({ path: ['ok', seg, 'x'] }))).toBe('path');
  });

  it('accepts strings and non-negative integers, spaces included', () => {
    expect(validate(withOp({ path: ['hello world', 0, 12, 'x'] }))).toBeNull();
    expect(
      validate(base({ origin: 'tab 1', writer: 'w 1', instance: 'g 1' })),
    ).toBeNull();
    expect(validate(base({ instance: '' }))).toBeNull();
  });
});

describe('validateEnvelope: well-formed envelopes', () => {
  it('accepts a base envelope, a root set, and clean cites', () => {
    expect(validate(base())).toBeNull();
    expect(validate(withOp({ path: [] }))).toBeNull();
    expect(
      validate(withOp({ cites: [{ origin: 'o2', hlc: { p: 1, l: 3 } }] })),
    ).toBeNull();
    expect(
      validate(base({ ops: [op({ path: [] }), op({ path: ['a', 0] })] })),
    ).toBeNull();
    expect(validate(withOp({ kind: 'delete', path: ['a'] }))).toBeNull();
    expect(validate(withOp({ kind: 'clear', path: ['a'] }))).toBeNull();
  });
});
