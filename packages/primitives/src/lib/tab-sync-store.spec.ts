import {
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { store } from './store';
import { isConflicted, preserve } from './store/op-sync';
import { MessageBus, tabSync, type TabSyncBus } from './tab-sync';

type State = { v: string; nested: { a: number; b: number } };
const initial = (): State => ({ v: 'init', nested: { a: 0, b: 0 } });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tabSync (store mode)', () => {
  const injectors: EnvironmentInjector[] = [];

  // each simulated tab gets its own injector and therefore its own MessageBus/channel
  function tab(opt?: { policies?: Parameters<typeof preserve>[] }) {
    const env = createEnvironmentInjector(
      [MessageBus],
      TestBed.inject(EnvironmentInjector),
    );
    injectors.push(env);
    const s = runInInjectionContext(env, () =>
      tabSync(store<State>(initial()), {
        id: 'st',
        injector: env.get(Injector),
        helloTimeoutMs: 40,
        jitterMs: 1,
        ...(opt as object),
      }),
    );
    return s;
  }

  afterEach(() => {
    for (const env of injectors.splice(0)) env.destroy();
  });

  it('replicates leaf writes between tabs as ops', async () => {
    const a = tab();
    await wait(60); // a becomes base
    const b = tab();
    await wait(60); // b hydrates from a

    a.v.set('from-a');
    TestBed.tick();
    await wait(20);

    expect(b().v).toBe('from-a');
    expect(b().nested).toEqual({ a: 0, b: 0 });
  });

  it('concurrent writes to DIFFERENT leaves merge instead of clobbering (the op-mode win)', async () => {
    const a = tab();
    await wait(60);
    const b = tab();
    await wait(60);

    a.nested.a.set(1);
    b.nested.b.set(2);
    TestBed.tick();
    await wait(20);

    expect(a().nested).toEqual({ a: 1, b: 2 });
    expect(b().nested).toEqual({ a: 1, b: 2 });
  });

  it('jitterMs 0 answers a hello IN the message handler — no timer between responder and joiner', async () => {
    // A bus that delivers synchronously, so anything timer-scheduled is observably NOT yet there.
    // This is the shape hidden-tab throttling forces: a backgrounded responder's timers are
    // ≥1s-aligned while its message handlers run untouched, so "answers with no timer" is exactly
    // the property that decides whether a builder tab can hydrate its preview tab at all.
    const subs = new Map<string, Set<(msg: unknown) => void>>();
    const syncBus: TabSyncBus = {
      subscribe: (id, cb) => {
        let set = subs.get(id);
        if (!set) subs.set(id, (set = new Set()));
        const mine = cb as (msg: unknown) => void;
        set.add(mine);
        return {
          unsub: () => set.delete(mine),
          post: (value) => {
            for (const listener of [...set]) if (listener !== mine) listener(value);
          },
        };
      },
    };
    const syncTab = (jitterMs: number) => {
      const env = createEnvironmentInjector([MessageBus], TestBed.inject(EnvironmentInjector));
      injectors.push(env);
      return runInInjectionContext(env, () =>
        tabSync(store<State>(initial()), {
          id: 'st-sync',
          injector: env.get(Injector),
          helloTimeoutMs: 40,
          jitterMs,
          bus: syncBus,
        }),
      );
    };

    const a = syncTab(0);
    await wait(60); // a self-bases into being live
    a.v.set('held-by-a');
    TestBed.tick();
    await wait(10);

    // The joiner's hello, a's answer and the hydration all ride the synchronous bus: by the time
    // tabSync() returns, b IS hydrated — nothing was parked on a timer anywhere. (The jittered
    // default's timer-parked answer is covered by the hello-exchange legs below, which wait.)
    const b = syncTab(0);
    expect(b().v).toBe('held-by-a');
  });

  it('a joining tab hydrates existing state via the hello exchange', async () => {
    const a = tab();
    await wait(60);
    a.v.set('pre-existing');
    TestBed.tick();
    await wait(20);

    const b = tab();
    await wait(60);

    expect(b().v).toBe('pre-existing');
  });

  it('writes made by a joining tab before hydration survive it', async () => {
    const a = tab();
    await wait(60);
    a.nested.a.set(7);
    TestBed.tick();
    await wait(20);

    const b = tab();
    b.v.set('eager'); // written while still joining
    TestBed.tick();
    await wait(60); // hydration lands, local write re-applied on top

    expect(b().nested.a).toBe(7); // got a's state
    expect(b().v).toBe('eager'); // kept its own
    expect(a().v).toBe('eager'); // and a received it
  });

  it('a lone tab times out into being the base and works standalone', async () => {
    const a = tab();
    await wait(60);

    a.v.set('solo');
    TestBed.tick();
    await wait(10);

    expect(a().v).toBe('solo');
  });

  it('concurrent same-leaf writes converge to one winner on both tabs', async () => {
    const a = tab();
    await wait(60);
    const b = tab();
    await wait(60);

    a.v.set('A');
    b.v.set('B');
    TestBed.tick();
    await wait(30);

    expect(a().v).toBe(b().v);
    expect(['A', 'B']).toContain(a().v);
  });

  it('preserve policy carries a Conflicted leaf across tabs', async () => {
    const policies = [{ path: 'v', merge: preserve }];
    const a = tab({ policies } as never);
    await wait(60);
    const b = tab({ policies } as never);
    await wait(60);

    a.v.set('A');
    b.v.set('B');
    TestBed.tick();
    await wait(30);

    expect(isConflicted(a().v)).toBe(true);
    expect(a().v).toEqual(b().v);
  });
});
