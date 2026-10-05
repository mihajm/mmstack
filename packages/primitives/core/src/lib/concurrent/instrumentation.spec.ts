import { computed, Injector, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  perfCustomTracks,
  provideConcurrencyInstrumentation,
  type ConcurrencyInstrumentation,
} from './instrumentation';
import {
  getTransitionScope,
  injectRegisterResource,
  provideTransitionScope,
  type ResourceLike,
  type TransitionScope,
} from './transition-scope';
import { memberId } from './census';

function fakeResource(status: () => ResourceStatus): ResourceLike & {
  set(s: ResourceStatus): void;
} {
  const s = signal<ResourceStatus>(status());
  return {
    status: s,
    isLoading: signal(false),
    hasValue: () => true,
    abort: () => undefined,
    set: (next) => s.set(next),
  };
}

describe('concurrency instrumentation seam', () => {
  function recorder() {
    const events: string[] = [];
    const listener: ConcurrencyInstrumentation = {
      pendingStart: (e) => {
        events.push(`pending:start(${e.scope},res=${e.resources})`);
        return { started: true };
      },
      pendingEnd: () => events.push('pending:end'),
      resourceRegistered: (e) =>
        events.push(`register(${e.scope},sus=${e.suspends})`),
      resourceRemoved: (e) => events.push(`remove(${e.scope})`),
      abortPending: (e) => events.push(`abort(${e.scope},n=${e.aborted})`),
    };
    return { events, listener };
  }

  it('emits register/remove and a pending span across a scope', () => {
    const { events, listener } = recorder();
    TestBed.configureTestingModule({
      providers: [
        provideConcurrencyInstrumentation(listener),
        provideTransitionScope({ name: 'case' }),
      ],
    });

    const register = TestBed.runInInjectionContext(() =>
      injectRegisterResource(),
    );
    const res = fakeResource(() => 'resolved');
    TestBed.runInInjectionContext(() => register(res));
    TestBed.tick();

    expect(events).toContain('register(case,sus=true)');

    res.set('loading');
    TestBed.tick();
    res.set('resolved');
    TestBed.tick();

    expect(events).toContain('pending:start(case,res=1)');
    expect(events).toContain('pending:end');
  });

  it('reports abortPending with the aborted count', () => {
    const { events, listener } = recorder();
    TestBed.configureTestingModule({
      providers: [
        provideConcurrencyInstrumentation(listener),
        provideTransitionScope({ name: 'case' }),
      ],
    });
    const register = TestBed.runInInjectionContext(() =>
      injectRegisterResource(),
    );
    const res = fakeResource(() => 'loading');
    TestBed.runInInjectionContext(() => register(res));

    const scope = getTransitionScope(TestBed.inject(Injector));
    if (!scope) throw new Error('expected a transition scope');
    const aborted = scope.abortPending();

    expect(aborted).toBe(1);
    expect(events).toContain('abort(case,n=1)');
  });

  it('is entirely zero-cost with no listener installed', () => {
    TestBed.configureTestingModule({
      providers: [provideTransitionScope({ name: 'case' })],
    });
    const register = TestBed.runInInjectionContext(() =>
      injectRegisterResource(),
    );
    const res = fakeResource(() => 'loading');
    expect(() => {
      TestBed.runInInjectionContext(() => register(res));
      TestBed.tick();
      res.set('resolved');
      TestBed.tick();
    }).not.toThrow();
  });

  it('perfCustomTracks returns handles and never throws when performance.measure is unusable', () => {
    const preset = perfCustomTracks('test-track');
    const handle = preset.pendingStart?.({ scope: 'x', resources: 1, at: 5 });
    expect(handle).toBe(5);
    expect(() => preset.pendingEnd?.(handle, { at: 10 })).not.toThrow();
  });
});

// ── A6: failure / retry round / dismissal taps ──────────────────────────────

type FailingFake = ResourceLike & {
  set(s: ResourceStatus, error?: unknown): void;
  readonly reloads: () => number;
  readonly errorReads: () => number;
};

function failingResource(): FailingFake {
  const s = signal<ResourceStatus>('loading');
  const err = signal<unknown>(undefined);
  let reloads = 0;
  let errorReads = 0;
  // Counts reads, so a spec can tell whether anything watches the failure.
  const error = (() => {
    errorReads++;
    return err();
  }) as unknown as ResourceLike['error'];
  return {
    status: s,
    isLoading: computed(() => s() === 'loading'),
    hasValue: () => false,
    error,
    reload: () => {
      reloads++;
      s.set('loading');
      err.set(undefined);
      return true;
    },
    set: (next, e) => {
      s.set(next);
      err.set(e);
    },
    reloads: () => reloads,
    errorReads: () => errorReads,
  };
}

function setup(listener?: ConcurrencyInstrumentation): {
  scope: TransitionScope;
  res: FailingFake;
} {
  TestBed.configureTestingModule({
    providers: [
      ...(listener ? [provideConcurrencyInstrumentation(listener)] : []),
      provideTransitionScope({ name: 'case' }),
    ],
  });
  const register = TestBed.runInInjectionContext(() =>
    injectRegisterResource(),
  );
  const res = failingResource();
  TestBed.runInInjectionContext(() => register(res, { displayName: 'orders' }));
  const scope = getTransitionScope(TestBed.inject(Injector));
  if (!scope) throw new Error('expected a transition scope');
  return { scope, res };
}

/** A dismissable failure: an enrolled facade without a retry, failed at generation 1. */
function failFacade(scope: TransitionScope, displayName: string): void {
  const id = memberId('facade', displayName);
  const facade = scope.census.enroll({ id, displayName, retry: undefined });
  facade.started(1);
  facade.settled(1, {
    kind: 'error',
    error: { id, displayName, message: 'nope', generation: 1 },
  });
}

describe('concurrency instrumentation: failure taps (A6)', () => {
  it('resourceFailed fires once per failure episode, with the name and message', () => {
    const events: string[] = [];
    const { res } = setup({
      resourceFailed: (e) =>
        events.push(`failed(${e.scope},${e.name},${e.message},${typeof e.at})`),
    });
    TestBed.tick();
    expect(events).toEqual([]);

    res.set('error', new Error('boom'));
    TestBed.tick();
    TestBed.tick();
    expect(events).toEqual(['failed(case,orders,boom,number)']);

    // A second member failing recomputes the failure list; the first is still the same episode.
    const items = failingResource();
    TestBed.runInInjectionContext(() =>
      injectRegisterResource()(items, { displayName: 'items' }),
    );
    items.set('error', new Error('gone'));
    TestBed.tick();
    expect(events).toEqual([
      'failed(case,orders,boom,number)',
      'failed(case,items,gone,number)',
    ]);

    res.set('resolved');
    TestBed.tick();
    res.set('error', new Error('again'));
    TestBed.tick();
    expect(events).toEqual([
      'failed(case,orders,boom,number)',
      'failed(case,items,gone,number)',
      'failed(case,orders,again,number)',
    ]);
  });

  it('retryRound fires after the round is claimed, with its dispatched count', () => {
    const events: string[] = [];
    const { scope, res } = setup({
      retryRound: (e) =>
        events.push(`round(${e.scope},${e.dispatched},${typeof e.at})`),
    });
    res.set('error', new Error('boom'));

    const round = scope.retryAll();
    expect(round.dispatched).toBe(1);
    expect(res.reloads()).toBe(1);
    expect(events).toEqual(['round(case,1,number)']);

    scope.retryAll(); // in flight now: a round that dispatches nothing
    expect(res.reloads()).toBe(1);
    expect(events).toEqual(['round(case,1,number)', 'round(case,0,number)']);

    res.set('error', new Error('boom'));
    const [member] = scope.census.snapshot();
    scope.retry(member.id);
    expect(events.at(-1)).toBe('round(case,1,number)');
  });

  it('dismissed fires per entry actually hidden, never for a no-op dismissal', () => {
    const events: string[] = [];
    const { scope } = setup({
      dismissed: (e) =>
        events.push(`dismissed(${e.scope},${e.name},${typeof e.at})`),
    });
    failFacade(scope, 'save');
    failFacade(scope, 'publish');
    failFacade(scope, 'export');

    const save = scope.errored().find((e) => e.failure.displayName === 'save');
    if (!save) throw new Error('expected the save entry');
    scope.dismiss(save);
    expect(events).toEqual(['dismissed(case,save,number)']);

    scope.dismiss(save); // already hidden
    expect(events).toEqual(['dismissed(case,save,number)']);

    scope.dismissAll();
    expect(events).toEqual([
      'dismissed(case,save,number)',
      'dismissed(case,publish,number)',
      'dismissed(case,export,number)',
    ]);
    expect(scope.errored()).toEqual([]);

    scope.dismissAll(); // nothing left to hide
    expect(events).toHaveLength(3);
  });

  it.each([
    ['no listener', undefined],
    [
      'a listener without the three hooks',
      { resourceRegistered: () => undefined },
    ],
  ] as const)(
    'with %s, no tap runs and no payload is built',
    (_, listener: ConcurrencyInstrumentation | undefined) => {
      const { scope, res } = setup(listener);
      failFacade(scope, 'save');
      res.set('error', new Error('boom'));
      TestBed.tick();
      // No failure watcher exists: nothing has read the error since it was set.
      expect(res.errorReads()).toBe(0);

      const now = vi.spyOn(globalThis.performance, 'now');
      try {
        scope.retryAll();
        const [entry] = scope.errored();
        scope.dismiss(entry);
        scope.dismissAll();
        // The `at` stamp is inside the payload: never built, never stamped.
        expect(now).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
      expect(res.reloads()).toBe(1);
    },
  );

  it('perfCustomTracks writes zero-length entries on its track for the three hooks', () => {
    const measure = vi.spyOn(globalThis.performance, 'measure');
    try {
      const preset = perfCustomTracks('test-track');
      preset.resourceFailed?.({
        scope: 'x',
        name: 'orders',
        message: 'boom',
        at: 7,
      });
      preset.retryRound?.({ scope: 'x', dispatched: 2, at: 8 });
      preset.dismissed?.({ scope: 'x', name: 'save', at: 9 });
      const entry = (color: string, at: number) => ({
        start: at,
        end: at,
        detail: {
          devtools: { dataType: 'track-entry', track: 'test-track', color },
        },
      });
      expect(measure.mock.calls).toEqual([
        ['failed: orders', entry('error', 7)],
        ['retry (2)', entry('tertiary', 8)],
        ['dismissed: save', entry('secondary', 9)],
      ]);
    } finally {
      measure.mockRestore();
    }
  });
});
