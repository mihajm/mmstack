import {
  Component,
  computed,
  effect,
  PLATFORM_ID,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import * as barrel from '../../index';
import { transactional } from './active-transaction';
import {
  type AsyncTransactionRef,
  injectStartTransaction,
  type Transaction,
  type TransactionOutcome,
  type TransactionRef,
} from './transaction';
import { abortTransaction } from './transaction-driver';
import {
  injectTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

type Flight = ResourceLike & {
  status: WritableSignal<ResourceStatus>;
  loads: WritableSignal<number>;
};
function flight(): Flight {
  const status = signal<ResourceStatus>('resolved');
  return {
    status,
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => true,
    loads: signal(0),
  };
}
/** Start a load on `f`, the way a resource's request path does. */
const kick = (f: Flight) => {
  f.loads.update((n) => n + 1);
  f.status.set('loading');
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
  reject(e: unknown): void;
};
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'atx-host',
  template: ``,
  providers: [provideTransitionScope()],
})
class Host {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly a = signal(0);
  readonly b = signal(0);
  readonly wa = transactional(this.a);
  readonly wb = transactional(this.b);
  readonly fa = flight();
  readonly fb = flight();
  readonly display = this.scope.hold(computed(() => `${this.a()}/${this.b()}`));
  constructor() {
    this.scope.add(this.fa, { suspends: false });
    this.scope.add(this.fb, { suspends: false });
  }
}

async function setup(server = false) {
  const { fixture } = await render(Host, {
    providers: server ? [{ provide: PLATFORM_ID, useValue: 'server' }] : [],
  });
  const host = fixture.componentInstance;
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  expect(host.display()).toBe('0/0'); // baseline read before any hold
  return { fixture, host, flush };
}

const microtasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Track a ref's settlement without awaiting it. */
function track(ref: { done: Promise<TransactionOutcome> }) {
  const seen: TransactionOutcome[] = [];
  void ref.done.then((o) => seen.push(o));
  return seen;
}

describe('startTransaction with an async body', () => {
  it('holds the display across awaits, records writes re-entered with enter, completes after the body and a render', async () => {
    const { host, flush } = await setup();
    const gate = deferred();
    let tx!: Transaction;
    const ref = host.start(async (t) => {
      tx = t;
      host.wa.set(1);
      await gate.promise;
      t.enter(() => host.wb.set(2));
    });
    const seen = track(ref);
    const trace: string[] = [];
    const sample = () => trace.push(`${ref.pending()}:${host.display()}`);

    await flush();
    sample();
    expect(tx.entries().map((e) => e.target)).toEqual([host.a]);

    gate.resolve();
    await microtasks();
    expect(tx.entries().map((e) => e.target)).toEqual([host.a, host.b]);
    sample(); // the body returned, the render has not passed yet
    await flush();
    sample();

    expect(trace).toEqual(['true:0/0', 'true:0/0', 'false:1/2']);
    expect(seen).toEqual([{ kind: 'completed' }]);
    expect(host.scope.holding()).toBe(false);
  });

  it('a write after an await without enter lands, survives abort, and the hold still spans it', async () => {
    const { host, flush } = await setup();
    const gate = deferred();
    const ref = host.start(async () => {
      host.wa.set(1);
      await gate.promise;
      host.wb.set(2); // forgot enter
    });
    gate.resolve();
    await microtasks();
    expect(host.b()).toBe(2);
    expect(host.display()).toBe('0/0'); // still held
    ref.abort();
    await flush();
    expect([host.a(), host.b()]).toEqual([0, 2]);
    expect(host.display()).toBe('0/2');
  });

  it('abort mid-await restores every slice, settles at once and ignores the late continuation', async () => {
    const { host, flush } = await setup();
    const gate = deferred();
    let lateError: unknown;
    const ref = host.start(async (t) => {
      host.wa.set(1);
      await Promise.resolve();
      t.enter(() => host.wb.set(2));
      t.enter(() => kick(host.fa));
      t.retain();
      await gate.promise;
      try {
        t.enter(() => host.wa.set(99));
      } catch (e) {
        lateError = e;
        host.wb.set(7); // the documented limit: a direct write still lands
        throw e;
      }
    });
    const seen = track(ref);
    await flush();
    expect([host.a(), host.b(), ref.pending(), host.scope.holding()]).toEqual([
      1,
      2,
      true,
      true,
    ]);

    ref.abort();
    expect([host.a(), host.b(), ref.pending(), host.scope.holding()]).toEqual([
      0,
      0,
      false,
      false,
    ]);
    await flush();
    expect(seen).toEqual([{ kind: 'aborted', reason: 'abort' }]);

    gate.resolve();
    await flush();
    expect(lateError).toBeInstanceOf(Error);
    expect(host.a()).toBe(0);
    expect(host.b()).toBe(7);
    expect(seen).toEqual([{ kind: 'aborted', reason: 'abort' }]);
  });

  it('a rejection restores and settles failed with the same error; done never rejects', async () => {
    const { host, flush } = await setup();
    const boom = new Error('boom');
    const ref = host.start(async (t) => {
      host.wa.set(1);
      await Promise.resolve();
      t.enter(() => host.wb.set(2));
      throw boom;
    });
    const outcome = await ref.done;
    expect(outcome).toEqual({ kind: 'failed', error: boom });
    expect((outcome as { error: unknown }).error).toBe(boom);
    await flush();
    expect([host.a(), host.b(), host.display()]).toEqual([0, 0, '0/0']);
  });

  {
    const ends: [string, (ref: AsyncTransactionRef, gate: Deferred) => void][] =
      [
        ['abort', (r) => r.abort()],
        ['superseded', (r) => abortTransaction(r, 'superseded')],
        ['completed', (_, g) => g.resolve()],
        ['failed', (_, g) => g.reject(new Error('x'))],
      ];
    for (const [name, end] of ends)
      it(`enter and retain throw once the transaction settled: ${name}`, async () => {
        const { host, flush } = await setup();
        const gate = deferred();
        let tx!: Transaction;
        const ref = host.start(async (t) => {
          tx = t;
          await gate.promise;
        });
        end(ref, gate);
        await flush();
        expect(ref.pending()).toBe(false);
        let ran = false;
        expect(() => tx.enter(() => (ran = true)), name).toThrow(/closed/);
        expect(ran).toBe(false);
        expect(() => tx.retain(), name).toThrow(/closed/);
      });
  }
});

describe('startTransaction with an async body: attribution, retains, cancellation reasons', () => {
  it('a kickoff inside a slice holds only its own transaction; one between slices holds every open one', async () => {
    const { host, flush } = await setup();
    const ga = deferred();
    const gb = deferred();
    let ta!: Transaction;
    const A = host.start(async (t) => {
      ta = t;
      await ga.promise;
    });
    const B = host.start(async () => {
      await gb.promise;
    });
    const seenA = track(A);
    const seenB = track(B);

    ta.enter(() => kick(host.fa)); // A's own load
    ga.resolve();
    gb.resolve();
    await flush();
    expect(seenB).toEqual([{ kind: 'completed' }]); // B never waited on A's load
    expect(seenA).toEqual([]);
    host.fa.status.set('resolved');
    await flush();
    expect(seenA).toEqual([{ kind: 'completed' }]);

    const gc = deferred();
    const gd = deferred();
    const C = host.start(async () => {
      await gc.promise;
    });
    const D = host.start(async () => {
      await gd.promise;
    });
    const seenC = track(C);
    const seenD = track(D);
    kick(host.fb); // foreign, between slices: window-attributed to both
    gc.resolve();
    gd.resolve();
    await flush();
    expect([seenC, seenD]).toEqual([[], []]);
    host.fb.status.set('resolved');
    await flush();
    expect([seenC, seenD]).toEqual([
      [{ kind: 'completed' }],
      [{ kind: 'completed' }],
    ]);
  });

  it('a load scheduled by the last slice after the body returned still holds the transaction', async () => {
    const { host, fixture, flush } = await setup();
    // a request that reacts to `a` and starts its load from an effect, after the slice
    const ref = host.start(async (t) => {
      await Promise.resolve();
      t.enter(() => host.wa.set(5));
    });
    const seen = track(ref);
    const stop = effect(
      () => {
        if (host.a() === 5) kick(host.fb);
      },
      { injector: fixture.debugElement.injector },
    );
    await flush();
    expect(host.fb.status()).toBe('loading');
    expect(seen).toEqual([]);
    expect(host.display()).toBe('0/0');
    host.fb.status.set('resolved');
    await flush();
    expect(seen).toEqual([{ kind: 'completed' }]);
    expect(host.display()).toBe('5/0');
    stop.destroy();
  });

  it('completion waits for every retain; releasing twice is harmless', async () => {
    const { host, flush } = await setup();
    let release!: () => void;
    const ref = host.start(async (t) => {
      release = t.retain();
    });
    const seen = track(ref);
    await flush();
    expect([seen, ref.pending()]).toEqual([[], true]);
    release();
    release();
    await flush();
    expect(seen).toEqual([{ kind: 'completed' }]);
  });

  it('a driver supersede settles aborted with reason superseded; only the driver call is on the public barrel', async () => {
    const { host, flush } = await setup();
    const ref = host.start(async (t) => {
      host.wa.set(3);
      await new Promise(() => undefined);
      t.enter(() => host.wa.set(4));
    });
    abortTransaction(ref, 'superseded');
    await flush();
    expect(await ref.done).toEqual({ kind: 'aborted', reason: 'superseded' });
    expect(host.a()).toBe(0);
    abortTransaction(ref, 'abort'); // settled: no-op
    expect(await ref.done).toEqual({ kind: 'aborted', reason: 'superseded' });
    expect(barrel.abortTransaction).toBe(abortTransaction); // exported for drivers in other packages
    expect('bindAbort' in barrel).toBe(false);
  });

  it('destroy mid-await restores and settles aborted with reason destroyed', async () => {
    const { host, fixture } = await setup();
    const ref = host.start(async (t) => {
      host.wa.set(1);
      await Promise.resolve();
      t.enter(() => host.wb.set(2));
      await new Promise(() => undefined);
    });
    await microtasks();
    expect([host.a(), host.b()]).toEqual([1, 2]);
    fixture.destroy();
    expect(await ref.done).toEqual({ kind: 'aborted', reason: 'destroyed' });
    expect([host.a(), host.b()]).toEqual([0, 0]);
  });

  it('destroy keeps the writes of a synchronous transaction, as before', async () => {
    const { host, fixture } = await setup();
    const ref: TransactionRef = host.start(() => {
      host.wa.set(1);
      kick(host.fa);
    });
    fixture.destroy();
    await ref.done;
    expect(host.a()).toBe(1);
  });

  it('on the server an async transaction completes when its body returns and nothing is in flight', async () => {
    const { host } = await setup(true);
    const ref = host.start(async (t) => {
      await Promise.resolve();
      t.enter(() => host.wa.set(2));
    });
    expect(await ref.done).toEqual({ kind: 'completed' });
    expect(host.display()).toBe('2/0');
  });
});

describe('startTransaction nested inside a slice joins the outer transaction', () => {
  it('a nested synchronous call: same transaction, writes in the outer log, done follows the outer', async () => {
    const { host, flush } = await setup();
    const gate = deferred();
    let outer!: Transaction;
    let inner: Transaction | undefined;
    let nested!: TransactionRef;
    const ref = host.start(async (t) => {
      outer = t;
      await gate.promise;
      t.enter(() => {
        nested = host.start((n) => {
          inner = n;
          host.wb.set(4);
        });
      });
    });
    const seen = track(ref);
    let nestedDone = false;
    gate.resolve();
    await microtasks();
    void nested.done.then(() => (nestedDone = true));
    expect(inner).toBe(outer);
    expect(outer.entries().map((e) => e.target)).toEqual([host.b]);
    expect(nested.pending).toBe(ref.pending);
    await flush();
    expect(seen).toEqual([{ kind: 'completed' }]);
    expect(nestedDone).toBe(true);
  });

  it("the nested ref's abort aborts the outer: one log, one outcome", async () => {
    const { host, flush } = await setup();
    let nested!: TransactionRef;
    const ref = host.start(async (t) => {
      host.wa.set(1);
      await Promise.resolve();
      t.enter(() => {
        nested = host.start(() => host.wb.set(2));
      });
      await new Promise(() => undefined);
    });
    const seen = track(ref);
    await microtasks();
    expect([host.a(), host.b()]).toEqual([1, 2]);
    nested.abort();
    await flush();
    expect([host.a(), host.b()]).toEqual([0, 0]);
    expect(seen).toEqual([{ kind: 'aborted', reason: 'abort' }]);
  });

  it('a nested async body keeps the outer open until it resolves; its rejection fails the outer', async () => {
    const { host, flush } = await setup();
    const inner = deferred();
    let nested!: AsyncTransactionRef;
    const ref = host.start(async (t) => {
      t.enter(() => {
        nested = host.start(async (n) => {
          host.wa.set(1);
          await inner.promise;
          n.enter(() => host.wb.set(2));
        });
      });
    });
    const seen = track(ref);
    const seenNested = track(nested);
    await flush();
    expect([seen, ref.pending(), host.display()]).toEqual([[], true, '0/0']);
    inner.resolve();
    await flush();
    expect(seen).toEqual([{ kind: 'completed' }]);
    expect(seenNested).toEqual(seen);
    expect(host.display()).toBe('1/2');

    const failing = deferred();
    const boom = new Error('nested');
    const ref2 = host.start(async (t) => {
      t.enter(() => {
        host.start(async () => {
          host.wa.set(9);
          await failing.promise;
        });
      });
    });
    failing.reject(boom);
    expect(await ref2.done).toEqual({ kind: 'failed', error: boom });
    expect(host.a()).toBe(1);
  });
});
