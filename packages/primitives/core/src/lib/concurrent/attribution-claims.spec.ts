import { computed, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  claimLoads,
  createAttributedPending,
  createTransitionScope,
  releaseClaims,
  snapshotLoads,
  type ResourceLike,
} from './transition-scope';

function world(withLoads: boolean, initial: ResourceStatus = 'resolved') {
  const status = signal<ResourceStatus>(initial);
  const loads = signal(0);
  const ref: ResourceLike = {
    status,
    isLoading: computed(
      () => status() === 'loading' || status() === 'reloading',
    ),
    hasValue: () => true,
    ...(withLoads ? { loads } : {}),
  };
  const scope = TestBed.runInInjectionContext(() => createTransitionScope());
  scope.add(ref);
  return {
    scope,
    start: (s: ResourceStatus = 'loading') => {
      status.set(s);
      loads.update((n) => n + 1);
    },
    settle: () => status.set('resolved'),
  };
}

describe('slice claims seen through attributed pending', () => {
  it('a sibling read while the load runs unclaimed lets go once another owner claims it', () => {
    const w = world(true);
    const a = {};
    const pb = createAttributedPending(w.scope, {});
    for (let round = 0; round < 2; round++) {
      const before = snapshotLoads(w.scope);
      w.start();
      expect(pb()).toBe(true);
      claimLoads(w.scope, a, before);
      expect(pb()).toBe(false);
      w.settle();
    }
  });

  it('a released owner stops counting its own in-flight claim, over two transactions', () => {
    const w = world(true);
    for (let round = 0; round < 2; round++) {
      const owner = {};
      const pa = createAttributedPending(w.scope, owner);
      const before = snapshotLoads(w.scope);
      w.start();
      claimLoads(w.scope, owner, before);
      expect(pa()).toBe(true);
      releaseClaims(w.scope, owner);
      expect(pa()).toBe(false);
      w.settle();
    }
  });

  for (const withLoads of [true, false]) {
    it(`a refetch that keeps its value (reloading) counts (loads counter: ${withLoads})`, () => {
      const w = world(withLoads);
      const pa = createAttributedPending(w.scope, {});
      w.start('reloading');
      expect(pa()).toBe(true);
      w.settle();
      expect(pa()).toBe(false);
    });
  }

  it('without a counter, a flight running at the mark is excluded until a read sees it settle', () => {
    const w = world(false, 'loading');
    const pa = createAttributedPending(w.scope, {});
    expect(pa()).toBe(false);
    w.settle();
    expect(pa()).toBe(false);
    w.start();
    expect(pa()).toBe(true);
  });
});
