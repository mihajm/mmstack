import { Component, computed, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { deferredValue, type DeferStrategy } from './deferred-value';

/** Manual scheduler: catch-ups run only when the test flushes; cancels are tracked. */
function manualScheduler() {
  let queue: (() => void)[] = [];
  let cancelled = 0;
  const strategy: DeferStrategy = (cb) => {
    queue.push(cb);
    return () => {
      const idx = queue.indexOf(cb);
      if (idx >= 0) {
        queue.splice(idx, 1);
        cancelled++;
      }
    };
  };
  return {
    strategy,
    flush: () => {
      const run = queue;
      queue = [];
      for (const cb of run) cb();
    },
    get scheduled() {
      return queue.length;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe('deferredValue', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'browser' }],
    });
  });

  it('holds the previous value until the scheduler fires, then catches up', () => {
    const sched = manualScheduler();
    const source = signal('a');
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source, { strategy: sched.strategy }),
    );
    TestBed.tick(); // initial watch effect
    sched.flush(); // initial (same-value) catch-up
    expect(deferred()).toBe('a');
    expect(deferred.pending()).toBe(false);

    source.set('b');
    TestBed.tick();
    expect(deferred()).toBe('a'); // urgent read: still the held value
    expect(deferred.pending()).toBe(true); // ...and honestly behind

    sched.flush();
    expect(deferred()).toBe('b');
    expect(deferred.pending()).toBe(false);
  });

  it('rapid changes coalesce: only the LATEST value is applied (prior catch-ups cancel)', () => {
    const sched = manualScheduler();
    const source = signal(0);
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source, { strategy: sched.strategy }),
    );
    TestBed.tick();
    sched.flush();
    const cancelledBefore = sched.cancelled;

    const applied: number[] = [];
    const watcher = computed(() => {
      applied.push(deferred());
      return deferred();
    });
    watcher();

    source.set(1);
    TestBed.tick();
    source.set(2);
    TestBed.tick();
    source.set(3);
    TestBed.tick();
    expect(sched.scheduled).toBe(1); // one live catch-up — the rest cancelled
    expect(sched.cancelled).toBe(cancelledBefore + 2);

    sched.flush();
    watcher();
    expect(deferred()).toBe(3);
    expect(applied).toEqual([0, 3]); // the expensive subtree never saw 1 or 2
  });

  it('a change that reverts before catch-up is not pending, and an equal catch-up never notifies', () => {
    const sched = manualScheduler();
    const source = signal('x');
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source, { strategy: sched.strategy }),
    );
    TestBed.tick();
    sched.flush();

    let notifications = 0;
    const watcher = computed(() => {
      notifications++;
      return deferred();
    });
    watcher();
    expect(notifications).toBe(1);

    source.set('y'); // type a char...
    TestBed.tick();
    source.set('x'); // ...delete it before the deferred view caught up
    TestBed.tick();
    expect(deferred.pending()).toBe(false); // behind-ness is by VALUE, not schedule

    sched.flush(); // applies 'x' over 'x'
    watcher();
    expect(notifications).toBe(1); // consumers never re-ran
  });

  it('honors a custom equal', () => {
    const sched = manualScheduler();
    const source = signal({ id: 1, label: 'a' });
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source, {
        strategy: sched.strategy,
        equal: (a, b) => a.id === b.id,
      }),
    );
    TestBed.tick();
    sched.flush();

    source.set({ id: 1, label: 'b' }); // equal by id
    TestBed.tick();
    expect(deferred.pending()).toBe(false);

    source.set({ id: 2, label: 'b' });
    TestBed.tick();
    expect(deferred.pending()).toBe(true);
    sched.flush();
    expect(deferred().id).toBe(2);
  });

  it('destroying the injection context cancels the owed catch-up', () => {
    const sched = manualScheduler();
    const source = signal(0);
    @Component({ template: '' })
    class Host {}
    const fixture = TestBed.createComponent(Host);
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source, {
        strategy: sched.strategy,
        injector: fixture.componentRef.injector,
      }),
    );
    TestBed.tick();
    sched.flush();

    source.set(1);
    TestBed.tick();
    expect(sched.scheduled).toBe(1);

    fixture.destroy();
    expect(sched.scheduled).toBe(0); // cancelled — nothing fires into a dead context
    expect(deferred()).toBe(0);
  });

  it('is a synchronous pass-through on the server (SSR renders once)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const source = signal('a');
    const deferred = TestBed.runInInjectionContext(() =>
      deferredValue(source),
    );
    source.set('b');
    expect(deferred()).toBe('b'); // no deferral
    expect(deferred.pending()).toBe(false);
  });
});
