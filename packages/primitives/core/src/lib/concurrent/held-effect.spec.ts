import {
  Component,
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  Injector,
  type ResourceStatus,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { heldEffect } from './held-effect';
import {
  createTransitionScope,
  getTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

function setup(initiallyHeld = false) {
  const held = signal(initiallyHeld);
  const a = signal(0);
  const b = signal('x');
  const runs: string[] = [];
  const cleaned: string[] = [];
  const injector = TestBed.inject(Injector);
  const ref = heldEffect(
    (onCleanup) => {
      const seen = `${a()}${b()}`;
      runs.push(seen);
      onCleanup(() => cleaned.push(seen));
    },
    { gate: held, injector },
  );
  const tick = () => TestBed.tick();
  return { held, a, b, runs, cleaned, ref, tick };
}

describe('heldEffect', () => {
  it('with nothing held it behaves as effect: one run per batch of changes', () => {
    const { a, b, runs, tick } = setup();
    tick();
    a.set(1);
    b.set('y');
    tick();
    tick();
    a.set(2);
    tick();
    expect(runs).toEqual(['0x', '1y', '2y']);
  });

  it('changes while held run nothing; the release runs once with the latest values', () => {
    const { held, a, b, runs, tick } = setup();
    tick();
    held.set(true);
    tick();
    a.set(1);
    tick();
    b.set('y');
    tick();
    a.set(2);
    tick();
    expect(runs).toEqual(['0x']);
    held.set(false);
    tick();
    tick();
    expect(runs).toEqual(['0x', '2y']);
  });

  it('a change after it went stale is still one run at release', () => {
    const { held, a, runs, tick } = setup();
    tick();
    held.set(true);
    a.set(1);
    tick();
    a.set(5);
    tick();
    expect(runs).toEqual(['0x']);
    held.set(false);
    tick();
    expect(runs).toEqual(['0x', '5x']);
  });

  it('the gate closing and a change in the same batch is not lost', () => {
    const { held, a, runs, tick } = setup();
    tick();
    held.set(true);
    a.set(7);
    tick();
    expect(runs).toEqual(['0x']);
    held.set(false);
    tick();
    expect(runs).toEqual(['0x', '7x']);
  });

  it('a hold with no change in it runs nothing at release', () => {
    const { held, runs, tick } = setup();
    tick();
    held.set(true);
    tick();
    held.set(false);
    tick();
    held.set(true);
    tick();
    held.set(false);
    tick();
    expect(runs).toEqual(['0x']);
  });

  it('held from creation, the first run waits for the release', () => {
    const { held, a, runs, tick } = setup(true);
    tick();
    a.set(3);
    tick();
    expect(runs).toEqual([]);
    held.set(false);
    tick();
    expect(runs).toEqual(['3x']);
  });

  it('after the release it tracks again', () => {
    const { held, a, b, runs, tick } = setup();
    tick();
    held.set(true);
    a.set(1);
    tick();
    held.set(false);
    tick();
    b.set('z');
    tick();
    expect(runs).toEqual(['0x', '1x', '1z']);
  });

  it('cleanup runs right before the release run, not when the change was held', () => {
    const { held, a, cleaned, runs, tick } = setup();
    tick();
    held.set(true);
    tick();
    a.set(1);
    tick();
    expect(cleaned).toEqual([]);
    held.set(false);
    tick();
    expect(cleaned).toEqual(['0x']);
    expect(runs).toEqual(['0x', '1x']);
  });

  it('destroyed while held: no run, and the last run is cleaned up once', () => {
    const { held, a, cleaned, runs, ref, tick } = setup();
    tick();
    held.set(true);
    a.set(1);
    tick();
    ref.destroy();
    ref.destroy();
    held.set(false);
    tick();
    a.set(2);
    tick();
    expect(runs).toEqual(['0x']);
    expect(cleaned).toEqual(['0x']);
  });
});

function fakeResource(status: ResourceStatus): ResourceLike & {
  status: ReturnType<typeof signal<ResourceStatus>>;
} {
  const s = signal<ResourceStatus>(status);
  return {
    status: s,
    isLoading: computed(() => s() === 'loading' || s() === 'reloading'),
    hasValue: () => s() === 'resolved',
  };
}

describe('heldEffect default gate', () => {
  it('is held while the scope holds a transaction and while a load is in flight', () => {
    const scope = createTransitionScope({ injector: TestBed.inject(Injector) });
    const res = fakeResource('resolved');
    scope.add(res);
    const a = signal(0);
    const runs: number[] = [];
    heldEffect(() => runs.push(a()), {
      scope,
      injector: TestBed.inject(Injector),
    });
    TestBed.tick();

    scope.beginHold();
    a.set(1);
    TestBed.tick();
    res.status.set('reloading');
    scope.endHold();
    TestBed.tick();
    a.set(2);
    TestBed.tick();
    expect(runs).toEqual([0]);

    res.status.set('resolved');
    TestBed.tick();
    expect(runs).toEqual([0, 2]);
  });

  it('reads the nearest transition scope from the injector by default', () => {
    const env = createEnvironmentInjector(
      [provideTransitionScope()],
      TestBed.inject(EnvironmentInjector),
    );
    const scope = getTransitionScope(env);
    if (!scope) throw new Error('no scope');
    const a = signal(0);
    const runs: number[] = [];
    heldEffect(() => runs.push(a()), { injector: env });
    TestBed.tick();
    scope.beginHold();
    a.set(1);
    TestBed.tick();
    expect(runs).toEqual([0]);
    scope.endHold();
    TestBed.tick();
    expect(runs).toEqual([0, 1]);

    scope.beginHold();
    a.set(2);
    TestBed.tick();
    env.destroy();
    scope.endHold();
    TestBed.tick();
    expect(runs).toEqual([0, 1]);
  });
});

describe('heldEffect in a component', () => {
  const held = signal(false);
  const a = signal(0);
  const runs: number[] = [];
  const cleaned: number[] = [];

  @Component({ selector: 'held-host', template: '' })
  class HeldHost {
    constructor() {
      heldEffect(
        (onCleanup) => {
          const v = a();
          runs.push(v);
          onCleanup(() => cleaned.push(v));
        },
        { gate: held },
      );
    }
  }

  it('runs as a view effect, and destroying the component while held runs nothing', async () => {
    const fixture = TestBed.createComponent(HeldHost);
    await fixture.whenStable();
    a.set(1);
    await fixture.whenStable();
    held.set(true);
    a.set(2);
    await fixture.whenStable();
    expect(runs).toEqual([0, 1]);
    fixture.destroy();
    held.set(false);
    TestBed.tick();
    expect(runs).toEqual([0, 1]);
    expect(cleaned).toEqual([0, 1]);
  });
});

describe('heldEffect: defaults and teardown', () => {
  it('with no options it runs, holds while the scope holds, and runs once on release', () => {
    TestBed.configureTestingModule({ providers: [provideTransitionScope()] });
    const scope = getTransitionScope(TestBed.inject(EnvironmentInjector));
    if (!scope) throw new Error('scope not provided');
    const a = signal(0);
    const runs: number[] = [];
    TestBed.runInInjectionContext(() => heldEffect(() => void runs.push(a())));
    TestBed.tick();
    scope.beginHold();
    a.set(1);
    TestBed.tick();
    a.set(2);
    TestBed.tick();
    expect(runs).toEqual([0]);
    scope.endHold();
    TestBed.tick();
    expect(runs).toEqual([0, 2]);
  });

  it('manualCleanup keeps it alive past its injector until destroyed', () => {
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const held = signal(false);
    const a = signal(0);
    const runs: number[] = [];
    const ref = heldEffect(() => void runs.push(a()), {
      injector: env,
      manualCleanup: true,
      gate: held,
    });
    TestBed.tick();
    held.set(true);
    a.set(1);
    TestBed.tick();
    env.destroy();
    held.set(false);
    TestBed.tick();
    a.set(2);
    TestBed.tick();
    expect(runs).toEqual([0, 1, 2]);
    ref.destroy();
    a.set(3);
    TestBed.tick();
    expect(runs).toEqual([0, 1, 2]);
  });

  it('destroyed while not held, a later change runs nothing and the gate is no longer read', () => {
    let gateReads = 0;
    const held = signal(false);
    const gate = () => (gateReads++, held());
    const a = signal(0);
    const runs: number[] = [];
    const ref = heldEffect(() => void runs.push(a()), {
      injector: TestBed.inject(Injector),
      gate,
    });
    TestBed.tick();
    ref.destroy();
    const reads = gateReads;
    a.set(1);
    held.set(true);
    TestBed.tick();
    held.set(false);
    TestBed.tick();
    expect(runs).toEqual([0]);
    expect(gateReads).toBe(reads);
  });
});
