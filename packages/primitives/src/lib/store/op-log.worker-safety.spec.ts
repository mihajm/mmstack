import { computed } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createStoreContext,
  diffOps,
  opLog,
  store,
  type OpBatch,
  type OpLogDriver,
} from './public_api';

/**
 * Worker-safety contract: `store` + `opLog` must run with NO Angular injector and NO TestBed, which
 * is the seam the worker-graph host relies on. This file imports neither `@angular/core/testing` nor
 * an injector. Emission is driven by an explicit `flush()` through a manual (no-op) driver, so the
 * whole test is synchronous and does not depend on `createWatch` (that concrete driver lives in
 * `@mmstack/worker/host`, keeping this package back-portable to older Angular majors).
 */

// a driver that never auto-runs: emission happens only via log.flush()
const manualDriver: OpLogDriver = () => ({ destroy: () => undefined });

type Model = { user: { name: string; age: number }; tags: string[] };
const initial = (): Model => ({ user: { name: 'ada', age: 36 }, tags: ['a'] });

function setup() {
  const ctx = createStoreContext(); // DI-less proxy cache
  const s = store<Model>(initial(), ctx);
  const batches: OpBatch[] = [];
  const log = opLog(s, { driver: manualDriver, origin: 'worker' });
  log.subscribe((b) => batches.push(b));
  return { s, log, batches };
}

describe('opLog worker-safety (no injector / no TestBed)', () => {
  it('builds an injector-free store with per-leaf reads and writes', () => {
    const { s } = setup();
    expect(s.user.name()).toBe('ada');
    s.user.name.set('grace');
    expect(s.user.name()).toBe('grace');
    expect(s().user.age).toBe(36); // untouched sibling intact
  });

  it('emits a minimal batch on flush', () => {
    const { s, log, batches } = setup();
    s.user.name.set('grace');
    log.flush();
    expect(batches).toEqual([
      {
        origin: 'worker',
        version: 1,
        ops: [{ kind: 'set', path: ['user', 'name'], next: 'grace', prev: 'ada' }],
      },
    ]);
  });

  it('applies a remote batch echo-free (no re-emission back onto the log)', () => {
    const { s, log, batches } = setup();
    log.apply([{ kind: 'set', path: ['user', 'age'], next: 40, prev: 36 }]);
    expect(s().user.age).toBe(40); // applied synchronously (one set)
    log.flush();
    expect(batches).toEqual([]); // echo-free: apply advanced the baseline, nothing emitted
  });

  it('propagates an applied batch to a downstream computed (recomputes once)', () => {
    const { s, log } = setup();
    let recomputes = 0;
    const view = computed(() => {
      recomputes++;
      return s.user.name();
    });
    expect(view()).toBe('ada'); // recomputes = 1
    log.apply([{ kind: 'set', path: ['user', 'name'], next: 'lin', prev: 'ada' }]);
    expect(view()).toBe('lin'); // one recompute for the one applied wave
    expect(recomputes).toBe(2);
  });

  it('exposes pure applyOps/diffOps that round-trip', () => {
    const a = initial();
    const b: Model = { ...a, user: { ...a.user, age: 41 }, tags: ['a', 'b'] };
    const ops = diffOps(a, b);
    expect(ops).toEqual([
      { kind: 'set', path: ['user', 'age'], next: 41, prev: 36 },
      { kind: 'set', path: ['tags'], prev: ['a'], next: ['a', 'b'] },
    ]);
    expect(applyOps(a, ops)).toEqual(b);
  });
});

describe('opLog.flush()', () => {
  it('is a no-op when nothing changed', () => {
    const { log, batches } = setup();
    log.flush();
    log.flush();
    expect(batches).toHaveLength(0);
  });

  it('coalesces writes since the last emission into one batch', () => {
    const { s, log, batches } = setup();
    s.user.name.set('a');
    s.user.age.set(40);
    log.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].ops).toEqual([
      { kind: 'set', path: ['user', 'name'], next: 'a', prev: 'ada' },
      { kind: 'set', path: ['user', 'age'], next: 40, prev: 36 },
    ]);
  });

  it('is idempotent: a second flush with nothing new emits nothing', () => {
    const { s, log, batches } = setup();
    s.tags.set(['a', 'b']);
    log.flush();
    log.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].version).toBe(1);
  });
});
