import { createStoreContext, opLog, store, type OpBatch } from '@mmstack/primitives';
import { microtaskOpLogDriver } from '@mmstack/worker/host';
import { describe, expect, it } from 'vitest';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('microtaskOpLogDriver', () => {
  it('drives opLog emission off the microtask queue with no injector', async () => {
    const s = store<{ n: number }>({ n: 0 }, createStoreContext());
    const batches: OpBatch[] = [];
    const log = opLog(s, { driver: microtaskOpLogDriver(), origin: 'w' });
    log.subscribe((b) => batches.push(b));
    await tick(); // bootstrap establishes the source dependency

    s.n.set(1);
    await tick();
    expect(batches).toEqual([
      { origin: 'w', version: 1, ops: [{ kind: 'set', path: ['n'], next: 1, prev: 0 }] },
    ]);

    s.n.set(2);
    await tick();
    expect(batches).toHaveLength(2);
    log.destroy();
  });

  it('stops emitting after destroy', async () => {
    const s = store<{ n: number }>({ n: 0 }, createStoreContext());
    const batches: OpBatch[] = [];
    const log = opLog(s, { driver: microtaskOpLogDriver(), origin: 'w' });
    log.subscribe((b) => batches.push(b));
    await tick();
    log.destroy();
    s.n.set(1);
    await tick();
    expect(batches).toHaveLength(0);
  });
});
