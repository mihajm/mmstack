import { invoke } from './algebra';
import {
  DONE,
  SENTINEL_KINDS,
  SentinelRegistryError,
  ifLoading,
  isAbsorbing,
  isDone,
  isLoading,
  isSentinel,
  isSentinelAware,
  joinSentinelRegistry,
  loading,
  sentinelAware,
} from './sentinel';
import type { SentinelRegistry } from './sentinel';

describe('sentinel', () => {
  describe('[ASSERTED] closed set', () => {
    it('exposes exactly the loading, done, and error kinds', () => {
      expect(SENTINEL_KINDS).toEqual(['loading', 'done', 'error']);
      expect(Object.isFrozen(SENTINEL_KINDS)).toBe(true);
    });

    it('creates frozen loading sentinels that satisfy both predicates', () => {
      const value = loading();
      expect(isSentinel(value)).toBe(true);
      expect(isLoading(value)).toBe(true);
      expect(Object.isFrozen(value)).toBe(true);
    });

    it('preserves provenance on the instance', () => {
      const source = { connector: 'users' };
      expect(loading(source).source).toBe(source);
      expect(loading().source).toBeUndefined();
    });
  });

  describe('[ASSERTED] DONE — the no-payload settlement sentinel', () => {
    it('is a single frozen sentinel satisfying isSentinel and isDone but not isLoading', () => {
      expect(isSentinel(DONE)).toBe(true);
      expect(isDone(DONE)).toBe(true);
      expect(isLoading(DONE)).toBe(false);
      expect(Object.isFrozen(DONE)).toBe(true);
      expect(DONE.kind).toBe('done');
    });

    it('isDone rejects loading sentinels, lookalikes, and primitives', () => {
      expect(isDone(loading())).toBe(false);
      expect(isDone({ kind: 'done', source: undefined })).toBe(false);
      expect(isDone(undefined)).toBe(false);
      expect(isDone(null)).toBe(false);
      expect(isDone('done')).toBe(false);
    });

    it('fails loud at serialization boundaries — it never launders into a def-plane artifact', () => {
      expect(() => JSON.stringify(DONE)).toThrow(/sentinel leaked/);
      expect(() => JSON.stringify({ name: 'ok', value: DONE })).toThrow(
        /sentinel leaked/,
      );
      expect(() => `${DONE}`).toThrow(/sentinel leaked/);
    });
  });

  describe('[ORACLE foreign-opacity] unregistered structural lookalikes are rejected', () => {
    it('rejects structural lookalikes', () => {
      expect(isSentinel({ kind: 'loading', source: undefined })).toBe(false);
      expect(isLoading({ kind: 'loading' })).toBe(false);
    });

    it('rejects in-language counterfeits minted via object spread', () => {
      const copy = { ...loading('src') };
      expect(copy.kind).toBe('loading');
      expect(isSentinel(copy)).toBe(false);
      expect(isSentinel({ ...loading(), kind: 'whatever' })).toBe(false);
    });

    it('rejects prototype-chain inheritance', () => {
      expect(isSentinel(Object.create(loading()))).toBe(false);
    });

    it('rejects foreign symbols and primitives', () => {
      expect(isSentinel(Symbol('loading'))).toBe(false);
      expect(isSentinel(null)).toBe(false);
      expect(isSentinel(undefined)).toBe(false);
      expect(isSentinel(NaN)).toBe(false);
      expect(isSentinel('loading')).toBe(false);
      expect(isSentinel(() => undefined)).toBe(false);
    });
  });

  describe('[ORACLE never-leak] coercion and serialization boundaries fail loud, never silently', () => {
    it('throws on string coercion instead of producing "[object Object]"', () => {
      expect(() => `${loading()}`).toThrow(/sentinel leaked/);
      expect(() => String(loading())).toThrow(/sentinel leaked/);
    });

    it('throws on arithmetic coercion instead of producing NaN', () => {
      expect(() => (loading() as unknown as number) + 1).toThrow(
        /sentinel leaked/,
      );
    });

    it('throws on property-key coercion instead of colliding on "[object Object]"', () => {
      const key = loading() as unknown as string;
      expect(() => ({ [key]: 1 })).toThrow(/sentinel leaked/);
    });

    it('throws on JSON serialization instead of laundering into plain data', () => {
      expect(() => JSON.stringify(loading())).toThrow(/sentinel leaked/);
      expect(() => JSON.stringify({ nested: loading() })).toThrow(
        /sentinel leaked/,
      );
    });
  });

  describe('[ASSERTED] sentinel-aware marking', () => {
    it('marks functions without changing identity or behavior', () => {
      const fn = (value: unknown) => value;
      const marked = sentinelAware(fn);
      expect(marked).toBe(fn);
      expect(isSentinelAware(marked)).toBe(true);
      expect(marked(7)).toBe(7);
    });

    it('leaves unmarked functions and non-functions unmarked', () => {
      expect(isSentinelAware(() => undefined)).toBe(false);
      expect(isSentinelAware(loading())).toBe(false);
      expect(isSentinelAware(5)).toBe(false);
      expect(isSentinelAware(undefined)).toBe(false);
    });

    it('[CHARACTERIZED] binding an aware function silently loses awareness', () => {
      const marked = sentinelAware((value: unknown) => value);
      expect(isSentinelAware(marked.bind(null))).toBe(false);
    });
  });

  describe('[ORACLE] the sentinel ships its own combinators, usable inside expressions', () => {
    const applyCall = (target: unknown, args: readonly unknown[]) =>
      (target as (...fnArgs: unknown[]) => unknown)(...args);

    it('isLoading is expression-usable: answers true through invoke instead of propagating', () => {
      expect(invoke(isLoading, [loading()], applyCall)).toBe(true);
      expect(invoke(isLoading, [42], applyCall)).toBe(false);
    });

    it('ifLoading absorbs through invoke', () => {
      expect(invoke(ifLoading, [loading(), 'fallback'], applyCall)).toBe(
        'fallback',
      );
      expect(invoke(ifLoading, [7, 'fallback'], applyCall)).toBe(7);
      expect(invoke(ifLoading, [null, 'fallback'], applyCall)).toBe(null);
    });
  });
});

describe('[PIN registry] the sentinel registry — one Symbol.for slot holding a versioned protocol record', () => {
  const KEY = Symbol.for('@mmstack/primitives.sentinels');
  const globalRecord = () =>
    (globalThis as unknown as Record<symbol, unknown>)[KEY] as SentinelRegistry;
  const applyCall = (target: unknown, args: readonly unknown[]) =>
    (target as (...fnArgs: unknown[]) => unknown)(...args);

  it('a sentinel is recognised through a registry reference obtained independently of this module', () => {
    const l = loading();
    expect(isSentinel(l)).toBe(true);
    const record = globalRecord();
    expect(record.protocol).toBe(2);
    expect(record.sentinels.has(l as unknown as object)).toBe(true);
    expect(record.sentinels.has({})).toBe(false);
  });

  it('aware functions are recognised through the same record', () => {
    const aware = sentinelAware(() => undefined);
    expect(isSentinelAware(aware)).toBe(true);
    expect(globalRecord().aware.has(aware)).toBe(true);
  });

  it('the global slot is non-enumerable, non-writable, non-configurable, and the record is frozen (slot stability)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(Object.isFrozen(descriptor?.value)).toBe(true);
  });

  it('recognition survives later WeakSet.prototype pollution — methods are captured at module init', () => {
    const l = loading();
    const originalHas = WeakSet.prototype.has;
    WeakSet.prototype.has = () => false;
    try {
      expect(isSentinel(l)).toBe(true);
      expect(isLoading(l)).toBe(true);
    } finally {
      WeakSet.prototype.has = originalHas;
    }
  });

  describe('joining', () => {
    it('mints a frozen protocol-2 record into an absent slot, installed non-configurable', () => {
      const host: Record<symbol, unknown> = {};
      const record = joinSentinelRegistry(host);
      expect(record.protocol).toBe(2);
      expect(Object.isFrozen(record)).toBe(true);
      expect(host[KEY]).toBe(record);
      const descriptor = Object.getOwnPropertyDescriptor(host, KEY);
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.writable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
    });

    it('joins an existing compatible record by reference — the dual-bundle case', () => {
      const host: Record<symbol, unknown> = {};
      const first = joinSentinelRegistry(host);
      expect(joinSentinelRegistry(host)).toBe(first);
    });

    it('fails loud at join time on a pre-seeded non-registry value, not at a distant .add', () => {
      expect(() => joinSentinelRegistry({ [KEY]: 'stomped' })).toThrow(
        SentinelRegistryError,
      );
      expect(() => joinSentinelRegistry({ [KEY]: null })).toThrow(
        SentinelRegistryError,
      );
    });

    it('fails loud on a foreign protocol number instead of silently not-recognising its sentinels', () => {
      const host: Record<symbol, unknown> = {
        [KEY]: { protocol: 3, sentinels: new WeakSet(), aware: new WeakSet() },
      };
      expect(() => joinSentinelRegistry(host)).toThrow(/protocol mismatch/);
      expect(() => joinSentinelRegistry({ [KEY]: {} })).toThrow(
        /protocol mismatch/,
      );
    });

    it('rejects a right-protocol record whose registries are malformed', () => {
      const host: Record<symbol, unknown> = {
        [KEY]: { protocol: 2, sentinels: new Set(), aware: new WeakSet() },
      };
      expect(() => joinSentinelRegistry(host)).toThrow(/malformed/);
    });
  });

  describe('[CHARACTERIZED] membership is authoritative — the accepted same-realm trade (see README trust model)', () => {
    it('a registry-inserted foreign object IS a recognised, absorbing sentinel', () => {
      const forged = { kind: 'loading', source: 'not-minted-here' };
      globalRecord().sentinels.add(forged);
      expect(isSentinel(forged)).toBe(true);
      expect(isLoading(forged)).toBe(true);
      expect(isAbsorbing(forged)).toBe(true);
    });

    it('membership does not confer mint invariants: a forged member is unfrozen and serializes silently', () => {
      const forged = { kind: 'loading' };
      globalRecord().sentinels.add(forged);
      expect(isSentinel(forged)).toBe(true);
      expect(Object.isFrozen(forged)).toBe(false);
      expect(JSON.stringify(forged)).toBe('{"kind":"loading"}');
    });

    it('a malformed member is recognised but never absorbing — absorption is decided by the kind read', () => {
      const malformed = { kind: 42 };
      globalRecord().sentinels.add(malformed);
      expect(isSentinel(malformed)).toBe(true);
      expect(isAbsorbing(malformed)).toBe(false);
      expect(isLoading(malformed)).toBe(false);
      expect(isDone(malformed)).toBe(false);
    });

    it('a registry-inserted function IS sentinel-aware: invoke hands it pending raw', () => {
      const received: unknown[] = [];
      const foreign = (value: unknown) => {
        received.push(value);
        return 'ran';
      };
      globalRecord().aware.add(foreign);
      expect(isSentinelAware(foreign)).toBe(true);
      const pending = loading();
      expect(invoke(foreign, [pending], applyCall)).toBe('ran');
      expect(received[0]).toBe(pending);
    });
  });
});
