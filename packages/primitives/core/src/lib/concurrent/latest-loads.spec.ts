import {
  computed,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { latest, use, type UseSource } from './latest';
import {
  createAttributedPending,
  createTransitionScope,
} from './transition-scope';

type Member = UseSource<number> & {
  readonly st: WritableSignal<ResourceStatus>;
  readonly count: WritableSignal<number>;
  start(): void;
};

function member(status: ResourceStatus, counted = true): Member {
  const st = signal<ResourceStatus>(status);
  const count = signal(status === 'loading' ? 1 : 0);
  const value = signal<number | undefined>(
    status === 'resolved' ? 1 : undefined,
  );
  return {
    st,
    count,
    status: st,
    value,
    hasValue: () => value() !== undefined,
    ...(counted ? { loads: count.asReadonly() } : {}),
    start: () => {
      st.set('loading');
      count.update((n) => n + 1);
    },
  };
}

describe('latest().loads', () => {
  it('sums forward moves of used members, counting each from when it is first observed', () => {
    const a = member('resolved');
    const b = member('resolved');
    const l = latest(() => use(a) + use(b));
    expect(l.loads()).toBe(0); // first sight adds nothing
    a.start();
    a.start(); // an abort+restart
    expect(l.loads()).toBe(2);
    b.start();
    expect(l.loads()).toBe(3);
  });

  it('is monotone when a member stops being used', () => {
    const which = signal<'a' | 'b'>('a');
    const a = member('resolved');
    const b = member('resolved');
    const l = latest(() => (which() === 'a' ? use(a) : use(b)));
    expect(l.loads()).toBe(0);
    a.start();
    expect(l.loads()).toBe(1);
    a.st.set('resolved');
    which.set('b'); // a leaves the deps; its contribution stays
    expect(l.loads()).toBe(1);
    b.start();
    expect(l.loads()).toBe(2);
  });

  it('a member that leaves and comes back adds its moves since it was last seen', () => {
    const which = signal<'a' | 'b'>('a');
    const a = member('resolved');
    const b = member('resolved');
    const l = latest(() => (which() === 'a' ? use(a) : use(b)));
    expect(l.loads()).toBe(0);
    a.start();
    expect(l.loads()).toBe(1);
    a.st.set('resolved');
    which.set('b');
    expect(l.loads()).toBe(1);
    a.start();
    a.start(); // moves while not used
    which.set('a');
    expect(l.loads()).toBe(3);
  });

  it('is undefined while any used member keeps no counter', () => {
    const a = member('resolved');
    const plain = member('resolved', false);
    const l = latest(() => use(a) + use(plain));
    expect(l.loads()).toBeUndefined();
  });

  it('re-reading without moves does not add (no double count across recomputes)', () => {
    const a = member('resolved');
    const other = signal(0);
    const l = latest(() => use(a) + other());
    expect(l.loads()).toBe(0);
    a.start();
    expect(l.loads()).toBe(1);
    other.set(1); // re-evaluates, same counts
    other.set(2);
    expect(l.loads()).toBe(1);
  });

  it('attribution: a pre-existing latest whose member restarts is the transaction own work', () => {
    const a = member('loading');
    const { scope, l } = TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const l = latest(() => use(a));
      scope.add(l, { suspends: false });
      return { scope, l };
    });
    expect(l.status()).toBe('loading');
    const pending = createAttributedPending(scope);
    expect(pending()).toBe(false);
    a.start(); // restart: status never leaves loading
    expect(pending()).toBe(true);
    const seen = computed(() => l.loads());
    expect(seen()).toBe(1);
  });
});
