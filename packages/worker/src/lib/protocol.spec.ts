import {
  deserializeError,
  generateId,
  serializeError,
  storeFrontierEquals,
  takeTransferables,
  transfer,
  UNKNOWN_FRONTIER,
} from '@mmstack/worker/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roundTrip = (thrown: unknown): Error =>
  deserializeError(structuredClone(serializeError(thrown)));

describe('serializeError / deserializeError', () => {
  it.each([
    ['a string', 'boom', 'boom'],
    ['an object', { code: 1 }, '{"code":1}'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, '42'],
  ])(
    'a thrown %s crosses as a named Error with a readable message',
    (_, thrown, message) => {
      const err = roundTrip(thrown);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('Error');
      expect(err.message).toBe(message);
      expect(err.cause).toBeUndefined();
      expect(typeof err.stack).toBe('string');
    },
  );

  it('a value JSON cannot render still crosses with a message', () => {
    const err = roundTrip(10n);
    expect(err.name).toBe('Error');
    expect(err.message).toBe('10');
  });

  it('keeps name, message and the thrower stack of an Error', () => {
    const e = new TypeError('bad input');
    const err = roundTrip(e);
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('bad input');
    expect(err.stack).toBe(e.stack);
    expect(err.cause).toBeUndefined();
  });

  it('keeps the cause chain', () => {
    const err = roundTrip(
      new Error('outer', { cause: new RangeError('inner') }),
    );
    expect(err.message).toBe('outer');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).name).toBe('RangeError');
    expect((err.cause as Error).message).toBe('inner');
  });

  it('keeps a non-Error cause', () => {
    const err = roundTrip(new Error('outer', { cause: 'why' }));
    expect((err.cause as Error).message).toBe('why');
  });

  it('stops at a self-referential cause instead of overflowing the stack', () => {
    const e = new Error('loop');
    e.cause = e;
    const s = serializeError(e);
    expect(s.message).toBe('loop');
    expect(s.cause).toBeUndefined();
    expect(roundTrip(e).message).toBe('loop');
  });

  it('stops at a cause cycle of two errors, keeping each error once', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    const err = roundTrip(a);
    expect(err.message).toBe('a');
    expect((err.cause as Error).message).toBe('b');
    expect((err.cause as Error).cause).toBeUndefined();
  });

  it('keeps a shared but acyclic cause on every branch', () => {
    const root = new Error('root');
    const err = roundTrip(
      new Error('top', { cause: new Error('mid', { cause: root }) }),
    );
    expect(((err.cause as Error).cause as Error).message).toBe('root');
  });
});

describe('generateId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['no crypto', undefined],
    ['crypto without randomUUID (non-secure context)', {}],
  ])('falls back with %s: non-empty and unique', (_, crypto) => {
    vi.stubGlobal('crypto', crypto);
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('is unique with randomUUID available', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('transfer / takeTransferables', () => {
  it('returns the same value and records its transfer list', () => {
    const buf = new ArrayBuffer(8);
    const value = { buf };
    expect(transfer(value, [buf])).toBe(value);
    expect(takeTransferables(value)).toEqual([buf]);
  });

  it('has nothing for an unmarked value or a non-object', () => {
    expect(takeTransferables({})).toBeUndefined();
    expect(takeTransferables(null)).toBeUndefined();
    expect(takeTransferables(7)).toBeUndefined();
    expect(takeTransferables('x')).toBeUndefined();
  });
});

describe('storeFrontierEquals', () => {
  it('an unknown generation never equals anything, itself included', () => {
    expect(storeFrontierEquals(UNKNOWN_FRONTIER, UNKNOWN_FRONTIER)).toBe(false);
    const f = { instance: '', applied: { a: { p: 1, l: 0 } } };
    expect(storeFrontierEquals(f, { ...f })).toBe(false);
  });

  it('equal within one generation, unequal across generations', () => {
    const applied = { a: { p: 1, l: 0 } };
    expect(
      storeFrontierEquals(
        { instance: 'h', applied },
        { instance: 'h', applied },
      ),
    ).toBe(true);
    expect(
      storeFrontierEquals(
        { instance: 'h', applied },
        { instance: 'k', applied },
      ),
    ).toBe(false);
  });
});
