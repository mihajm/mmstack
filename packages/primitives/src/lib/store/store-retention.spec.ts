import {
  STORE_SHARED_GLOBALS,
  type ProxyCache,
  type ProxyCleanupRegistry,
} from './internals';
import { createStoreContext, store, type toStoreOptions } from './store';

/**
 * Pins the FinalizationRegistry held-value retention counterexample (found 2026-07-17 via the
 * studio render-bench accumulation tax): `getCachedChild` registered child proxies with a held
 * value that STRONGLY referenced `target` (the parent node's backing signal). Held values are
 * retained by the registry until its cleanup callbacks run — and callbacks are host tasks, so
 * inside any synchronous burst (benchmarks, tight loops, long jobs) they never run at all.
 * Every dropped subtree therefore kept its whole backing-signal ancestry (and through it the
 * value records) alive across GCs, growing the live set monotonically with total nodes ever
 * created. The fix holds `WeakRef(target)` instead: a dead subtree's records must be
 * collectable by a single GC pass with NO event-loop turns.
 *
 * Two witness layers, because GC timing cannot pin the defect deterministically in BOTH
 * directions: a microtask boundary leaves the record in V8's KeptAlive set (always-retained,
 * even fixed), while a task boundary lets natural-GC cleanup callbacks release a strong held
 * value before the assertion (can pass even unfixed). So: (1) the register-shape test is the
 * deterministic regression pin — held values may reference the target only through WeakRef;
 * (2) the gc() tests witness the end-to-end consequence for the FIXED code (records/proxies
 * collectable after one forced GC, no cleanup-callback turns needed). Object graphs are built
 * and dropped inside helper functions so V8's conservative stack scanning can't pin them via
 * stale frame slots.
 *
 * The gc() tests require --expose-gc (NODE_OPTIONS=--expose-gc); skipped otherwise.
 */

declare global {
  // eslint-disable-next-line no-var
  var gc: (() => void) | undefined;
}

const hasGc = typeof globalThis.gc === 'function';

function buildAndDropSubtree(): WeakRef<object> {
  const ctx = createStoreContext();
  const record = { a: { b: 1 } };
  const s = store(record, ctx);
  expect(s.a.b()).toBe(1);
  return new WeakRef(record);
}

function buildParentAndDropChild(): {
  s: ReturnType<typeof store<{ a: { b: number } }>>;
  childRef: WeakRef<object>;
} {
  const ctx = createStoreContext();
  const s = store({ a: { b: 1 } }, ctx);
  const child = s.a;
  expect(child.b()).toBe(1);
  return { s, childRef: new WeakRef(child) };
}

describe('store proxy-cache retention', () => {
  it('registers cleanup held values that reference the target only weakly', () => {
    const heldValues: unknown[] = [];
    const fakeRegistry = {
      register: (_target: object, held: unknown) => {
        heldValues.push(held);
      },
      unregister: () => true,
    } as unknown as ProxyCleanupRegistry;
    const cache: ProxyCache = new WeakMap();
    const opts: toStoreOptions = {
      [STORE_SHARED_GLOBALS]: { cache, registry: fakeRegistry },
    };

    const s = store({ a: { b: 1 } }, opts);
    expect(s.a.b()).toBe(1);

    expect(heldValues.length).toBeGreaterThan(0);
    for (const held of heldValues) {
      const record = held as Record<string, unknown>;
      expect(record['targetRef']).toBeInstanceOf(WeakRef);
      for (const value of Object.values(record)) {
        if (typeof value === 'object' && value !== null) {
          expect(value).toBeInstanceOf(WeakRef);
        }
      }
    }
  });

  it.runIf(hasGc)(
    'a dropped store subtree does not retain its records once GC runs (no event-loop turns)',
    async () => {
      const recordRef = buildAndDropSubtree();

      await new Promise<void>((resolve) => setTimeout(resolve));

      globalThis.gc!();
      globalThis.gc!();

      expect(recordRef.deref()).toBeUndefined();
    },
  );

  it.runIf(hasGc)(
    'a live parent with a dropped child proxy stays prunable and rebuilds on next read',
    async () => {
      const { s, childRef } = buildParentAndDropChild();

      await new Promise<void>((resolve) => setTimeout(resolve));

      globalThis.gc!();
      globalThis.gc!();

      expect(childRef.deref()).toBeUndefined();
      expect(s.a.b()).toBe(1);
    },
  );
});
