import {
  computed,
  createEnvironmentInjector,
  EnvironmentInjector,
  signal,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  provideConcurrencyInstrumentation,
  type ConcurrencyInstrumentation,
} from './instrumentation';
import {
  getTransitionScope,
  provideTransitionScope,
  type ResourceLike,
  type TransitionScope,
} from './transition-scope';

type Fake = ResourceLike & { status: WritableSignal<ResourceStatus> };

function fake(status: ResourceStatus): Fake {
  const status$ = signal<ResourceStatus>(status);
  return {
    status: status$,
    isLoading: computed(
      () => status$() === 'loading' || status$() === 'reloading',
    ),
    hasValue: () => true,
    abort: () => status$.set('idle'),
  };
}

function boundary(listener: ConcurrencyInstrumentation) {
  TestBed.configureTestingModule({
    providers: [provideConcurrencyInstrumentation(listener)],
  });
  const injector = createEnvironmentInjector(
    [provideTransitionScope({ name: 'case' })],
    TestBed.inject(EnvironmentInjector),
  );
  const scope = getTransitionScope(injector) as TransitionScope;
  return { scope, destroy: () => injector.destroy() };
}

function recorder() {
  const events: string[] = [];
  const stamps: number[] = [];
  let n = 0;
  const listener: ConcurrencyInstrumentation = {
    pendingStart: (e) => {
      events.push(`start(${e.scope},${e.resources})`);
      stamps.push(e.at);
      return ++n;
    },
    pendingEnd: (h, e) => {
      events.push(`end(${h})`);
      stamps.push(e.at);
    },
    resourceRemoved: (e) => events.push(`remove(${e.scope})`),
    abortPending: (e) => {
      events.push(`abort(${e.aborted})`);
      stamps.push(e.at);
    },
  };
  return { listener, events, stamps };
}

describe('scope instrumentation: pending spans', () => {
  it('one start and one end per pending window, nothing while idle', () => {
    const { listener, events } = recorder();
    const { scope, destroy } = boundary(listener);
    TestBed.tick();
    expect(events).toEqual([]);

    const r = fake('loading');
    scope.add(r);
    TestBed.tick();
    r.status.set('resolved');
    TestBed.tick();
    r.status.set('reloading');
    TestBed.tick();
    r.status.set('resolved');
    TestBed.tick();
    expect(events).toEqual([
      'start(case,1)',
      'end(1)',
      'start(case,1)',
      'end(2)',
    ]);
    destroy();
    expect(events.length).toBe(4);
  });

  it('a scope destroyed mid-window ends its span once', () => {
    const { listener, events } = recorder();
    const { scope, destroy } = boundary(listener);
    scope.add(fake('loading'));
    TestBed.tick();
    destroy();
    expect(events.filter((e) => e.startsWith('end'))).toEqual(['end(1)']);
  });

  it('a listener with only pendingStart still gets every window and never throws', () => {
    const starts: number[] = [];
    const { scope, destroy } = boundary({
      pendingStart: (e) => starts.push(e.resources),
    });
    const r = fake('loading');
    scope.add(r);
    TestBed.tick();
    r.status.set('resolved');
    expect(() => TestBed.tick()).not.toThrow();
    r.status.set('loading');
    TestBed.tick();
    expect(starts).toEqual([1, 1]);
    expect(() => destroy()).not.toThrow();
  });

  it('every stamp is on the performance.now() timeline', () => {
    const { listener, stamps } = recorder();
    const t0 = performance.now();
    const { scope, destroy } = boundary(listener);
    const r = fake('loading');
    scope.add(r);
    TestBed.tick();
    scope.abortPending();
    TestBed.tick();
    const t1 = performance.now();
    expect(stamps.length).toBe(3);
    for (const at of stamps) {
      expect(at).toBeGreaterThanOrEqual(t0);
      expect(at).toBeLessThanOrEqual(t1);
    }
    destroy();
  });
});

describe('scope instrumentation: other hooks', () => {
  it('resourceRemoved names the scope', () => {
    const { listener, events } = recorder();
    const { scope, destroy } = boundary(listener);
    const r = fake('resolved');
    scope.add(r);
    scope.remove(r);
    expect(events).toContain('remove(case)');
    destroy();
  });

  it('abortPending works with a listener that has no abortPending hook', () => {
    const { scope, destroy } = boundary({ pendingStart: () => undefined });
    scope.add(fake('loading'));
    expect(scope.abortPending()).toBe(1);
    destroy();
  });
});
