import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  PendingTasks,
  PLATFORM_ID,
  signal,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heldEffect } from './held-effect';
import { injectStartTransition } from './start-transition';
import { createTransaction } from './transaction';
import {
  createTransitionScope,
  getTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
  registerResource,
  type ResourceLike,
  type TransitionScope,
} from './transition-scope';

type Fake = ResourceLike & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
};

function fake(status: ResourceStatus, value?: unknown): Fake {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(value);
  return {
    status: status$,
    value: value$,
    isLoading: computed(
      () => status$() === 'loading' || status$() === 'reloading',
    ),
    hasValue: () => value$() !== undefined && status$() !== 'error',
    error: computed(() =>
      status$() === 'error' ? new Error('boom') : undefined,
    ),
  };
}

const inContext = <T>(fn: () => T): T => TestBed.runInInjectionContext(fn);

describe('transition scope: registrations', () => {
  it('failed: a blank failed first load counts even while a mutation has also failed', () => {
    inContext(() => {
      const scope = createTransitionScope();
      scope.add(fake('error'));
      scope.add(fake('error'), { kind: 'mutation' });
      expect(scope.failed()).toBe(true);
    });
  });

  it("suspended('loading'): one suspending registration in flight is enough; an empty scope is not suspended", () => {
    inContext(() => {
      const scope = createTransitionScope();
      expect(scope.suspended('loading')).toBe(false);
      scope.add(fake('loading', 1));
      scope.add(fake('resolved', 1));
      expect(scope.suspended('loading')).toBe(true);
    });
  });

  it('a mutation drives pending but never suspends, whatever suspends says', () => {
    inContext(() => {
      const scope = createTransitionScope();
      scope.add(fake('loading'), { kind: 'mutation' });
      scope.add(fake('loading'), { kind: 'mutation', suspends: true });
      expect(scope.pending()).toBe(true);
      expect(scope.suspended('loading')).toBe(false);
      expect(scope.suspended('value')).toBe(false);
    });
  });

  it('remove takes out exactly the given ref; a second remove is a no-op', () => {
    inContext(() => {
      const scope = createTransitionScope();
      const a = fake('resolved', 1);
      const b = fake('loading', 1);
      const c = fake('resolved', 1);
      scope.add(a);
      scope.add(b);
      scope.add(c);
      scope.remove(b);
      expect(scope.resources()).toEqual([a, c]);
      expect(scope.pending()).toBe(false);
      expect(scope.census.snapshot().length).toBe(2);

      scope.remove(b);
      scope.remove(a);
      expect(() => scope.remove(a)).not.toThrow();
      expect(scope.resources()).toEqual([c]);
      expect(scope.census.snapshot().length).toBe(1);
    });
  });

  it('settled() of a scope created with no options resolves idle', async () => {
    const p = inContext(() => createTransitionScope().settled());
    TestBed.tick();
    await expect(p).resolves.toBe('idle');
  });
});

describe('transition scope: holds', () => {
  it('an extra endHold at 0 does not break the next hold', () => {
    inContext(() => {
      const scope = createTransitionScope();
      scope.endHold();
      scope.beginHold();
      expect(scope.holding()).toBe(true);
      scope.endHold();
      expect(scope.holding()).toBe(false);
    });
  });

  it('after a nested hold ends, the next hold seeds from its own first write', () => {
    inContext(() => {
      const a = createTransitionScope();
      const b = createTransitionScope();
      const x = signal(0);
      const write = (v: number) => {
        const txn = createTransaction();
        txn.enter(() => {
          txn.record(x as WritableSignal<unknown>);
          x.set(v);
        });
        txn.clear();
      };
      b.beginHold();
      a.beginHold();
      a.beginHold();
      write(1);
      a.endHold();
      a.endHold();

      a.beginHold();
      write(2);
      expect(a.hold(x)()).toBe(1);
      a.endHold();
      b.endHold();
    });
  });
});

describe('outside any boundary', () => {
  beforeEach(() =>
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  it('injectTransitionScope gives a working no-op scope', () => {
    inContext(() => {
      const scope: TransitionScope = injectTransitionScope();
      expect(scope).toBeTruthy();
      const r = fake('loading');
      expect(() => registerResource(r)).not.toThrow();
      expect(scope.resources()).toEqual([]);
      expect(scope.pending()).toBe(false);
      expect(scope.holding()).toBe(false);
      expect(scope.errored()).toEqual([]);

      const v = signal(1);
      const committed = scope.commit(v);
      const held = scope.hold(v);
      v.set(2);
      expect([committed(), held()]).toEqual([2, 2]);
    });
  });

  it('startTransition resolves and a heldEffect runs', async () => {
    let runs = 0;
    const t = inContext(() => {
      heldEffect(() => {
        runs++;
      });
      return injectStartTransition()(() => undefined);
    });
    expect(t.pending()).toBe(false);
    TestBed.tick();
    await t.done;
    expect(runs).toBeGreaterThan(0);
  });
});

describe('lifetimes', () => {
  it('a resource registered through registerResource leaves when its context is destroyed', () => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    const parent = TestBed.inject(EnvironmentInjector);
    const scope = getTransitionScope(parent) as TransitionScope;
    const child = createEnvironmentInjector([], parent);
    const r = fake('loading');
    child.runInContext(() => registerResource(r));
    expect(scope.resources()).toEqual([r]);
    child.destroy();
    expect(scope.resources()).toEqual([]);
    expect(scope.pending()).toBe(false);
  });

  it('on the server, destroying a scope mid-load releases its pending task', () => {
    let active = 0;
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: PendingTasks,
          useValue: {
            add: () => {
              active++;
              let done = false;
              return () => {
                if (!done) active--;
                done = true;
              };
            },
          },
        },
      ],
    });
    const child = createEnvironmentInjector(
      [provideTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    const scope = getTransitionScope(child) as TransitionScope;
    scope.add(fake('loading'));
    TestBed.tick();
    expect(active).toBe(1);
    child.destroy();
    expect(active).toBe(0);
  });
});
