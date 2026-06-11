import {
  Component,
  computed,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { activeTransaction, createTransaction, injectStartTransaction } from './transaction';
import {
  createTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
} from './transition-scope';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
};
function makeRef(status: ResourceStatus): FakeRef {
  const status$ = signal<ResourceStatus>(status);
  const value$ = signal<unknown>(1);
  return {
    status: status$,
    value: value$,
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => value$() !== undefined,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

describe('scope.hold (Tier 3 display hold)', () => {
  it('freezes while holding, reveals the live value on endHold', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const state = signal(1);
      const held = scope.hold(computed(() => state()));

      expect(held()).toBe(1);
      scope.beginHold();
      state.set(2);
      expect(held()).toBe(1); // frozen at pre-hold value
      state.set(3);
      expect(held()).toBe(1); // still frozen
      scope.endHold();
      expect(held()).toBe(3); // revealed live
    });
  });

  it('nested holds compose (counter) — releases only at the outermost endHold', () => {
    TestBed.runInInjectionContext(() => {
      const scope = createTransitionScope();
      const s = signal(1);
      const held = scope.hold(computed(() => s()));
      expect(held()).toBe(1); // establish the baseline (the binder reads every CD before a txn)

      scope.beginHold();
      scope.beginHold();
      s.set(2);
      scope.endHold();
      expect(held()).toBe(1); // still held (counter = 1)
      scope.endHold();
      expect(held()).toBe(2); // released
    });
  });
});

describe('createTransaction (undo log)', () => {
  it('records once and restores to the pre-write value', () => {
    const a = signal(1);
    const txn = createTransaction();
    txn.record(a as WritableSignal<unknown>);
    a.set(2);
    a.set(3); // record is once; restore still goes back to 1
    expect(a()).toBe(3);
    txn.restore();
    expect(a()).toBe(1);
  });

  it('clear keeps the live writes', () => {
    const a = signal(1);
    const txn = createTransaction();
    txn.record(a as WritableSignal<unknown>);
    a.set(2);
    txn.clear();
    txn.restore(); // nothing logged anymore
    expect(a()).toBe(2);
  });

  it('activeTransaction is null outside a transaction body', () => {
    expect(activeTransaction()).toBeNull();
  });
});

// eslint-disable-next-line @angular-eslint/component-selector
@Component({ selector: 'tx-host', template: ``, providers: [provideTransitionScope()] })
class Host {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly ref = makeRef('resolved');
  readonly state = signal(1);
  readonly display = this.scope.hold(computed(() => this.state()));
  constructor() {
    this.scope.add(this.ref, { suspends: false });
  }
  // a stateful write: record into the active transaction (if any), then write live.
  write(v: number) {
    activeTransaction()?.record(this.state as unknown as WritableSignal<unknown>);
    this.state.set(v);
  }
}

describe('injectStartTransaction', () => {
  const flush = async (fixture: { detectChanges(): void }) => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };

  it('holds the display during the transaction and reveals the committed value on settle', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    expect(host.display()).toBe(1);

    const t = host.start(() => {
      host.write(2); // staged + live write
      host.ref.status.set('loading'); // a resource reloads as a result
    });
    await flush(fixture);

    expect(t.pending()).toBe(true);
    expect(host.state()).toBe(2); // live state already updated (derived/connectors see it)
    expect(host.display()).toBe(1); // display HELD at pre-transaction value

    let resolved = false;
    void t.done.then(() => (resolved = true));

    host.ref.status.set('resolved'); // settle
    await flush(fixture);

    expect(t.pending()).toBe(false);
    expect(resolved).toBe(true);
    expect(host.display()).toBe(2); // revealed atomically on settle
  });

  it('abort rolls back the staged write and releases the hold', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.display()).toBe(1); // baseline read before the txn (binder reads every CD)

    const t = host.start(() => {
      host.write(2);
      host.ref.status.set('loading');
    });
    await flush(fixture);
    expect(host.display()).toBe(1); // held

    t.abort();
    await flush(fixture);

    expect(host.state()).toBe(1); // staged write rolled back
    expect(host.display()).toBe(1); // hold released, shows restored value
  });

  it('no-async transaction commits via the afterNextRender fallback', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    const t = host.start(() => host.write(5)); // no reload triggered
    let resolved = false;
    void t.done.then(() => (resolved = true));
    await flush(fixture);

    expect(resolved).toBe(true);
    expect(host.state()).toBe(5);
    expect(host.display()).toBe(5); // hold released, write kept
  });
});
