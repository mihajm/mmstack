import { signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  createAttributedPending,
  createTransitionScope,
  type ResourceLike,
} from './transition-scope';

/** A derivation that settled to `'error'` while one of its inputs is still loading. */
function erroredButLoading(withLoads: boolean) {
  const status = signal<ResourceStatus>('resolved');
  const loading = signal(false);
  const loads = signal(0);
  let aborts = 0;
  const ref: ResourceLike = {
    status,
    isLoading: loading,
    hasValue: () => status() !== 'error',
    abort: () => {
      aborts++;
      loading.set(false);
    },
    ...(withLoads ? { loads } : {}),
  };
  const start = () => {
    status.set('error');
    loading.set(true);
    loads.update((n) => n + 1);
  };
  return { ref, start, loading, aborts: () => aborts };
}

describe('activity, not status: an errored registration with work in flight', () => {
  it('is pending, and abortPending aborts it', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const r = erroredButLoading(true);
      scope.add(r.ref);
      r.start();
      expect(scope.pending()).toBe(true);
      expect(scope.abortPending()).toBe(1);
      expect(r.aborts()).toBe(1);
      expect(scope.pending()).toBe(false);
    });
  });

  for (const withLoads of [true, false]) {
    it(`a load the transaction started counts for it (loads counter: ${withLoads})`, () => {
      TestBed.runInInjectionContext(() => {
        const scope = createTransitionScope();
        const r = erroredButLoading(withLoads);
        scope.add(r.ref);
        const p = createAttributedPending(scope, {});
        r.start();
        expect(p()).toBe(true);
        r.loading.set(false);
        expect(p()).toBe(false);
      });
    });
  }

  it('a flight already running at the checkpoint is not attributed', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const r = erroredButLoading(false);
      scope.add(r.ref);
      r.start();
      const p = createAttributedPending(scope, {});
      expect(p()).toBe(false);
    });
  });
});
