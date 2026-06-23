import { computed, type ResourceRef, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createForwardingScope, createTransitionScope } from './transition-scope';

// Minimal fake matching the bits the scope reads: status(), isLoading(), hasValue().
function fakeResource(status: ResourceStatus, value: unknown): ResourceRef<unknown> {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(value);
  return {
    status: status$,
    value: value$,
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => value$() !== undefined,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
    set: (v: unknown) => value$.set(v),
  } as unknown as ResourceRef<unknown> & {
    status: ReturnType<typeof signal<ResourceStatus>>;
    value: ReturnType<typeof signal<unknown>>;
  };
}

describe('createTransitionScope', () => {
  it('pending reflects any in-flight resource (loading | reloading)', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      expect(scope.pending()).toBe(false); // empty

      const a = fakeResource('loading', undefined);
      scope.add(a);
      expect(scope.pending()).toBe(true);

      (a as any).status.set('resolved');
      expect(scope.pending()).toBe(false);

      (a as any).status.set('reloading'); // background refetch still counts as pending
      expect(scope.pending()).toBe(true);
    });
  });

  it("suspended('value') is the first-load check — false once a value is held (keepPrevious reload)", () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const r = fakeResource('loading', undefined);
      scope.add(r);

      expect(scope.suspended('value')).toBe(true); // no value yet → first-load placeholder

      (r as any).value.set({ ok: true });
      (r as any).status.set('reloading'); // value held, reloading
      expect(scope.suspended('value')).toBe(false); // does NOT re-suspend — holds stale
      expect(scope.pending()).toBe(true); // ...but the transition indicator is on
    });
  });

  it("suspended('loading') re-suspends on any in-flight request", () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const r = fakeResource('loading', { ok: true });
      scope.add(r);
      expect(scope.suspended('loading')).toBe(true);

      (r as any).status.set('resolved');
      expect(scope.suspended('loading')).toBe(false);
    });
  });

  it('remove deregisters a resource from the tracked set', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const a = fakeResource('loading', undefined);
      const b = fakeResource('resolved', 1);
      scope.add(a);
      scope.add(b);
      expect(scope.resources().length).toBe(2);
      expect(scope.pending()).toBe(true);

      scope.remove(a);
      expect(scope.resources().length).toBe(1);
      expect(scope.pending()).toBe(false); // only the resolved one remains
    });
  });

  it('suspends:false counts toward pending but never blanks the boundary', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const data = fakeResource('loading', undefined); // in-region data, first load
      scope.add(data, { suspends: false });

      expect(scope.pending()).toBe(true); // drives the indicator
      expect(scope.suspended('value')).toBe(false); // ...but does NOT suspend the boundary
    });
  });

  it('commit freezes a value while pending and reveals it once settled', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const r = fakeResource('resolved', 'A');
      scope.add(r, { suspends: false });
      const committed = scope.commit((r as any).value);

      expect(committed()).toBe('A');

      (r as any).status.set('reloading'); // transition begins
      (r as any).value.set('B'); // new value arrives mid-flight
      expect(committed()).toBe('A'); // frozen — not revealed yet

      (r as any).status.set('resolved'); // settled
      expect(committed()).toBe('B'); // revealed
    });
  });

  it('commit is coordinated: an early-settling resource waits for the slow one (no torn frame)', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const a = fakeResource('resolved', 'a0');
      const b = fakeResource('resolved', 'b0');
      scope.add(a, { suspends: false });
      scope.add(b, { suspends: false });
      const ca = scope.commit((a as any).value);
      const cb = scope.commit((b as any).value);

      expect(ca()).toBe('a0');
      expect(cb()).toBe('b0');

      // both start reloading
      (a as any).status.set('reloading');
      (b as any).status.set('reloading');

      // a resolves early; b still in flight → aggregate still pending
      (a as any).value.set('a1');
      (a as any).status.set('resolved');
      expect(ca()).toBe('a0'); // a is held back — coordinated with b

      // b resolves → everything settles → both reveal together
      (b as any).value.set('b1');
      (b as any).status.set('resolved');
      expect(ca()).toBe('a1');
      expect(cb()).toBe('b1');
    });
  });
});

describe('createForwardingScope', () => {
  it('with no target it behaves as its own scope', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      expect(fwd.pending()).toBe(false);

      const a = fakeResource('loading', undefined);
      fwd.add(a);
      expect(fwd.pending()).toBe(true);
      expect(fwd.resources().length).toBe(1);

      fwd.remove(a);
      expect(fwd.pending()).toBe(false);
      expect(fwd.resources().length).toBe(0);
    });
  });

  it('reads delegate to the current target and react to re-pointing', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const a = createTransitionScope();
      const b = createTransitionScope();
      a.add(fakeResource('loading', undefined));
      b.add(fakeResource('resolved', 1));

      fwd.setTarget(a);
      expect(fwd.pending()).toBe(true); // a is loading
      expect(fwd.resources().length).toBe(1);

      fwd.setTarget(b);
      expect(fwd.pending()).toBe(false); // b is settled
      expect(fwd.resources().length).toBe(1);

      fwd.setTarget(null);
      expect(fwd.resources().length).toBe(0); // back to the empty own-scope
    });
  });

  it('add/remove pin to the target current at add-time (re-point cannot strand a ref)', () => {
    TestBed.runInInjectionContext(() => {
      const fwd = createForwardingScope();
      const a = createTransitionScope();
      const b = createTransitionScope();

      const ref = fakeResource('loading', undefined);
      fwd.setTarget(a);
      fwd.add(ref); // lands in a
      expect(a.resources().length).toBe(1);

      fwd.setTarget(b); // re-point BEFORE the ref is removed
      fwd.remove(ref); // must remove from a (where it was added), not b
      expect(a.resources().length).toBe(0);
      expect(b.resources().length).toBe(0);
    });
  });
});
