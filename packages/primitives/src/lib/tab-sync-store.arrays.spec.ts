import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { store } from './store';
import { MessageBus, tabSync } from './tab-sync';

// A same-length array write travels as PER-INDEX ops (`diffOps` descends), so it lands under an
// ancestor register holding the whole array. These are the transport-level witnesses that such a
// write reaches its peers — including the peer that just hydrated, whose store would otherwise show
// the value while every other tab silently kept the stale array.

type State = { routes: string[]; items: { id: string }[] };
const initial = (): State => ({ routes: [], items: [] });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tabSync (store mode) — array element writes', () => {
  const injectors: EnvironmentInjector[] = [];

  function tab() {
    const env = createEnvironmentInjector(
      [MessageBus],
      TestBed.inject(EnvironmentInjector),
    );
    injectors.push(env);
    return runInInjectionContext(env, () =>
      tabSync(store<State>(initial()), {
        id: 'arr',
        injector: env.get(Injector),
        helloTimeoutMs: 40,
        jitterMs: 1,
      }),
    );
  }

  afterEach(() => {
    for (const env of injectors.splice(0)) env.destroy();
  });

  const settle = async (ms: number) => {
    TestBed.tick();
    await wait(ms);
    TestBed.tick();
  };

  it('a sparse array crosses the transport with its hole intact (structured clone, no JSON)', async () => {
    const a = tab();
    await settle(60);
    const b = tab();
    await settle(60);

    // eslint-disable-next-line no-sparse-arrays -- the hole IS the subject
    a.routes.set(['a', , 'c'] as string[]);
    await settle(30);

    expect(b().routes.length).toBe(3);
    expect(1 in b().routes).toBe(false);
    expect(Object.getPrototypeOf(b().routes)).toBe(Array.prototype);
  });

  it('replicates a same-length array write between tabs', async () => {
    const a = tab();
    await settle(60);
    const b = tab();
    await settle(60);

    a.routes.set(['x', 'y']); // length change → whole-array set
    await settle(30);
    expect(b().routes).toEqual(['x', 'y']);

    b.routes.set(['p', 'q']); // same length → per-index ops
    await settle(30);

    expect(b().routes).toEqual(['p', 'q']);
    expect(a().routes).toEqual(['p', 'q']);
  });

  it('replicates an edit to a record inside an array', async () => {
    const a = tab();
    await settle(60);
    const b = tab();
    await settle(60);

    a.items.set([{ id: 'r1' }, { id: 'r2' }]);
    await settle(30);

    b.items.set([{ id: 'r1' }, { id: 'r2-edited' }]);
    await settle(30);

    expect(a().items).toEqual([{ id: 'r1' }, { id: 'r2-edited' }]);
  });

  it('a rejoining tab that hydrates then writes a same-length array wins at the peer', async () => {
    const a = tab();
    await settle(60);
    a.routes.set(['old-a', 'old-b']);
    await settle(30);

    const b = tab(); // joins, hydrates a's array
    await settle(60);
    expect(b().routes).toEqual(['old-a', 'old-b']);

    b.routes.set(['fresh-1', 'fresh-2']); // same length as the hydrated value
    await settle(30);

    expect(b().routes).toEqual(['fresh-1', 'fresh-2']);
    expect(a().routes).toEqual(['fresh-1', 'fresh-2']);
  });
});
