import { Injector, signal, type ResourceStatus } from '@angular/core';
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
} from './transition-scope';

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
      resourceRegistered: (e) => events.push(`register(${e.scope},sus=${e.suspends})`),
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

    const register = TestBed.runInInjectionContext(() => injectRegisterResource());
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
    const register = TestBed.runInInjectionContext(() => injectRegisterResource());
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
    const register = TestBed.runInInjectionContext(() => injectRegisterResource());
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
