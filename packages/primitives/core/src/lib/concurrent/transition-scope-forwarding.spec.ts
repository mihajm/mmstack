import {
  computed,
  Injector,
  PendingTasks,
  PLATFORM_ID,
  signal,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { memberId, type CensusError } from './census';
import { injectStartTransaction } from './transaction';
import {
  createForwardingScope,
  createTransitionScope,
  getTransitionScope,
  provideForwardingTransitionScope,
  provideTransitionScope,
  type ForwardingTransitionScope,
  type ResourceLike,
  type TransitionScope,
} from './transition-scope';

type Fake = ResourceLike & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
  reloads: number;
  aborts: number;
};

function fake(status: ResourceStatus, value?: unknown): Fake {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(value);
  const r: Fake = {
    status: status$,
    value: value$,
    isLoading: computed(
      () => status$() === 'loading' || status$() === 'reloading',
    ),
    hasValue: () => value$() !== undefined && status$() !== 'error',
    error: computed(() =>
      status$() === 'error' ? new Error('boom') : undefined,
    ),
    reload: () => {
      r.reloads++;
      status$.set('loading');
      return true;
    },
    abort: () => {
      r.aborts++;
      status$.set('idle');
    },
    reloads: 0,
    aborts: 0,
  };
  return r;
}

function forwarder(): ForwardingTransitionScope {
  TestBed.configureTestingModule({
    providers: [provideForwardingTransitionScope()],
  });
  return getTransitionScope(
    TestBed.inject(Injector),
  ) as ForwardingTransitionScope;
}

describe('forwarding scope: a hold stays on the target it began on', () => {
  it('beginHold on A, re-point to B, endHold releases A and leaves B alone', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const a = createTransitionScope();
      const b = createTransitionScope();
      fwd.setTarget(a);
      fwd.beginHold();
      expect([a.holding(), b.holding()]).toEqual([true, false]);

      fwd.setTarget(b);
      b.beginHold();
      fwd.endHold();
      expect([a.holding(), b.holding()]).toEqual([false, true]);
      b.endHold();
      expect(b.holding()).toBe(false);
    });
  });

  it('a transaction that began on A releases A after the outlet re-points to B', () => {
    const fwd = forwarder();
    const a = createTransitionScope();
    const b = createTransitionScope();
    fwd.setTarget(a);
    const start = TestBed.runInInjectionContext(() => injectStartTransaction());

    const t = start((tx) => {
      tx.retain();
    });
    expect(a.holding()).toBe(true);
    fwd.setTarget(b);
    b.beginHold();
    t.abort();
    expect([a.holding(), b.holding()]).toEqual([false, true]);
    b.endHold();
  });

  it('overlapping transactions on A then B each release their own target', () => {
    const fwd = forwarder();
    const a = createTransitionScope();
    const b = createTransitionScope();
    fwd.setTarget(a);
    const start = TestBed.runInInjectionContext(() => injectStartTransaction());

    const t1 = start((tx) => {
      tx.retain();
    });
    fwd.setTarget(b);
    const t2 = start((tx) => {
      tx.retain();
    });
    expect([a.holding(), b.holding()]).toEqual([true, true]);

    t1.abort();
    expect([a.holding(), b.holding()]).toEqual([false, true]);
    t2.abort();
    expect([a.holding(), b.holding()]).toEqual([false, false]);
  });

  it('an extra endHold through the forwarder releases nothing', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const a = createTransitionScope();
      fwd.setTarget(a);
      a.beginHold();
      fwd.endHold();
      expect(a.holding()).toBe(true);
      a.endHold();
    });
  });
});

/** A: one blank failure (retryable). B: one first load in flight, and a hold. */
function targets() {
  const injector = TestBed.inject(Injector);
  const a = createTransitionScope({ name: 'a', injector });
  const failing = fake('error', undefined);
  a.add(failing, { displayName: 'a-fail' });
  const b = createTransitionScope({ name: 'b', injector });
  const loading = fake('loading', undefined);
  b.add(loading, { displayName: 'b-load' });
  b.beginHold();
  return { a, b, failing, loading, done: () => b.endHold() };
}

const reads: [string, (s: TransitionScope) => unknown][] = [
  ['resources', (s) => s.resources()],
  ['pending', (s) => s.pending()],
  ["suspended('value')", (s) => s.suspended('value')],
  ["suspended('loading')", (s) => s.suspended('loading')],
  ['holding', (s) => s.holding()],
  ['failed', (s) => s.failed()],
  ['errored', (s) => s.errored()],
  ['failures', (s) => s.failures()],
  ['census.foldState', (s) => s.census.foldState()],
  ['census.inFlight', (s) => s.census.inFlight()],
  ['census.failures', (s) => s.census.failures()],
  ['census.errored', (s) => s.census.errored()],
  ['census.snapshot', (s) => s.census.snapshot()],
];

describe('forwarding scope: every read follows the current target', () => {
  for (const [name, read] of reads) {
    it(name, () => {
      TestBed.runInInjectionContext(() => {
        const fwd = createForwardingScope();
        const t = targets();
        expect(read(t.a)).not.toEqual(read(t.b));
        const before = read(fwd);
        fwd.setTarget(t.a);
        expect(read(fwd)).toEqual(read(t.a));
        fwd.setTarget(t.b);
        expect(read(fwd)).toEqual(read(t.b));
        fwd.setTarget(null);
        expect(read(fwd)).toEqual(before);
        t.done();
      });
    });
  }

  it('a scope provided inside the forwarder holds while its target holds', () => {
    const fwd = forwarder();
    const child = Injector.create({
      providers: [provideTransitionScope()],
      parent: TestBed.inject(Injector),
    });
    const inner = getTransitionScope(child) as TransitionScope;
    const a = createTransitionScope();
    fwd.setTarget(a);
    expect(inner.holding()).toBe(false);
    a.beginHold();
    expect(inner.holding()).toBe(true);
    a.endHold();
    expect(inner.holding()).toBe(false);
  });
});

describe('forwarding scope: actions land on the current target', () => {
  it('commit freezes while the target is pending and reveals when it settles', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const t = targets();
      fwd.setTarget(t.b);
      const v = signal(1);
      const c = fwd.commit(v);
      expect(c()).toBe(1);
      v.set(2);
      expect(c()).toBe(1);
      t.loading.status.set('resolved');
      expect(c()).toBe(2);
      t.done();
    });
  });

  it('hold freezes while the target holds', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const t = targets();
      const v = signal(1);
      const h = fwd.hold(v);
      expect(h()).toBe(1);
      fwd.setTarget(t.b);
      v.set(2);
      expect(h()).toBe(1);
      t.done();
      expect(h()).toBe(2);
    });
  });

  it('retry, retryAll and their census twins re-run the target member', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const t = targets();
      fwd.setTarget(t.a);
      const id = t.a.failures()[0].id;
      const runs: [string, () => { dispatched: number }][] = [
        ['retry', () => fwd.retry(id)],
        ['retryAll', () => fwd.retryAll()],
        ['census.retry', () => fwd.census.retry(id)],
        ['census.retryAll', () => fwd.census.retryAll()],
      ];
      for (const [name, run] of runs) {
        t.failing.status.set('error');
        const before = t.failing.reloads;
        expect([name, run().dispatched]).toEqual([name, 1]);
        expect([name, t.failing.reloads]).toEqual([name, before + 1]);
      }
      t.done();
    });
  });
});

describe('forwarding scope: census actions and settlement', () => {
  const blankFailure = (id: CensusError['id'], generation: number) => ({
    kind: 'error' as const,
    error: { id, displayName: 'save', message: 'no', generation },
  });

  it('enroll and register land in the current target; dismiss and dismissAll act there', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const a = createTransitionScope();
      fwd.setTarget(a);
      const id = memberId('save', 1);
      const facade = fwd.census.enroll({
        id,
        displayName: 'save',
        retry: undefined,
      });
      expect(a.census.snapshot()).toContain(facade.member);

      facade.started(1);
      facade.settled(1, blankFailure(id, 1));
      expect(a.errored().length).toBe(1);
      fwd.dismiss(a.errored()[0]);
      expect(a.errored().length).toBe(0);

      facade.started(2);
      facade.settled(2, blankFailure(id, 2));
      expect(a.errored().length).toBe(1);
      fwd.dismissAll();
      expect(a.errored().length).toBe(0);

      const leave = fwd.census.register(facade.member);
      expect(
        a.census.snapshot().filter((m) => m === facade.member).length,
      ).toBe(2);
      leave();
    });
  });

  it('settled waits for the target and resolves its outcome', async () => {
    const fwd = forwarder();
    const injector = TestBed.inject(Injector);
    const b = createTransitionScope({ injector });
    const loading = fake('loading', undefined);
    b.add(loading);
    fwd.setTarget(b);

    let outcome: string | undefined;
    void fwd.settled().then((o) => (outcome = o));
    for (let i = 0; i < 3; i++) {
      TestBed.tick();
      await Promise.resolve();
    }
    expect(outcome).toBeUndefined();
    loading.value.set(1);
    loading.status.set('resolved');
    for (let i = 0; i < 3 && outcome === undefined; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r));
    }
    expect(outcome).toBe('idle');
  });
});

describe('provideForwardingTransitionScope', () => {
  it('passes its options to the fallback scope', () => {
    TestBed.configureTestingModule({
      providers: [
        provideForwardingTransitionScope({ precedence: 'error-first' }),
      ],
    });
    const fwd = getTransitionScope(TestBed.inject(Injector)) as TransitionScope;
    fwd.add(fake('error', undefined));
    fwd.add(fake('loading', undefined));
    expect(fwd.failed()).toBe(true);
  });

  it('settled works outside an injection context', async () => {
    const fwd = forwarder();
    let outcome: string | undefined;
    expect(() => void fwd.settled().then((o) => (outcome = o))).not.toThrow();
    for (let i = 0; i < 3 && outcome === undefined; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r));
    }
    expect(outcome).toBe('idle');
  });

  it('on the server, holds a pending task while a load registered through it runs', () => {
    let active = 0;
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: PendingTasks,
          useValue: {
            add: () => {
              active++;
              return () => active--;
            },
          },
        },
        provideForwardingTransitionScope(),
      ],
    });
    const fwd = getTransitionScope(TestBed.inject(Injector)) as TransitionScope;
    const r = fake('loading', undefined);
    fwd.add(r);
    TestBed.tick();
    expect(active).toBe(1);
    r.status.set('resolved');
    TestBed.tick();
    expect(active).toBe(0);
  });
});
