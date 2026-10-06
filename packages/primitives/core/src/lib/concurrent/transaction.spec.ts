import {
  Component,
  computed,
  inject,
  PLATFORM_ID,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { mutable } from '../mutable';
import {
  activeTransaction,
  createTransaction,
  injectStartTransaction,
  type Transaction,
  transactional,
} from './transaction';
import {
  createTransitionScope,
  injectTransitionScope,
  provideTransitionScope,
} from './transition-scope';
import { holdRegistrySize } from './hold-seed';

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

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tx-host',
  template: ``,
  providers: [provideTransitionScope()],
})
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
    activeTransaction()?.record(
      this.state as unknown as WritableSignal<unknown>,
    );
    this.state.set(v);
  }
}

// eslint-disable-next-line @angular-eslint/component-selector
@Component({ selector: 'tx-child', template: `` })
class Child {
  readonly start = injectStartTransaction();
  readonly ref = makeRef('resolved');
  constructor() {
    injectTransitionScope().add(this.ref, { suspends: false });
  }
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tx-wrap',
  imports: [Child],
  template: `@if (show()) {
    <tx-child />
  }`,
  providers: [provideTransitionScope()],
})
class Wrap {
  readonly show = signal(true);
  readonly scope = injectTransitionScope();
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

  it('commits a no-async transaction on the server without afterNextRender', async () => {
    const { fixture } = await render(Host, {
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const host = fixture.componentInstance;

    const t = host.start(() => host.write(5));
    await expect(t.done).resolves.toBeUndefined();
    expect(host.state()).toBe(5);
    expect(host.display()).toBe(5); // hold released, write kept
  });

  it('abort settles the done promise', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    const t = host.start(() => {
      host.write(2);
      host.ref.status.set('loading');
    });
    await flush(fixture);

    let resolved = false;
    void t.done.then(() => (resolved = true));

    t.abort();
    await flush(fixture);

    expect(resolved).toBe(true); // `await t.done` must not hang after abort
  });

  it('a pre-existing in-flight load is not attributed: it cannot commit the transaction early', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const bg = makeRef('loading'); // in flight BEFORE the transaction starts
    host.scope.add(bg, { suspends: false });
    expect(host.display()).toBe(1);

    const t = host.start(() => {
      host.write(2);
      host.ref.status.set('loading');
    });
    await flush(fixture);
    expect(t.pending()).toBe(true);

    bg.status.set('resolved'); // the background load settles — NOT the transaction's work
    await flush(fixture);
    expect(host.display()).toBe(1); // still held
    expect(t.pending()).toBe(true);

    host.ref.status.set('resolved'); // the transaction's own work settles
    await flush(fixture);
    expect(host.display()).toBe(2); // committed now
  });

  it('a never-settling background load does not block the transaction', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const bg = makeRef('loading');
    host.scope.add(bg, { suspends: false });
    expect(host.display()).toBe(1);

    const t = host.start(() => {
      host.write(2);
      host.ref.status.set('loading');
    });
    await flush(fixture);
    host.ref.status.set('resolved');
    await flush(fixture);

    expect(host.display()).toBe(2); // committed despite bg still loading
    expect(t.pending()).toBe(false);
  });

  it('destroying the calling context mid-transaction releases the hold on a surviving scope', async () => {
    const { fixture } = await render(Wrap);
    const wrap = fixture.componentInstance;
    const child = fixture.debugElement.query(
      (n) => n.componentInstance instanceof Child,
    ).componentInstance as Child;

    const t = child.start(() => child.ref.status.set('loading'));
    await flush(fixture);
    expect(wrap.scope.holding()).toBe(true);

    let resolved = false;
    void t.done.then(() => (resolved = true));

    wrap.show.set(false); // the transacting component is destroyed mid-flight
    await flush(fixture);

    expect(wrap.scope.holding()).toBe(false); // hold released — not leaked forever
    expect(resolved).toBe(true); // done settles so awaiters never hang
  });

  it('a throwing transaction body rolls back and releases the hold', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.display()).toBe(1); // baseline read before the txn

    expect(() =>
      host.start(() => {
        host.write(2);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await flush(fixture);

    expect(host.state()).toBe(1); // staged write rolled back
    expect(host.display()).toBe(1); // hold released — boundary must not stay frozen

    // the scope is still fully usable afterwards
    host.state.set(3);
    await flush(fixture);
    expect(host.display()).toBe(3);
  });
});

describe('recording mutable signals', () => {
  afterEach(() => vi.restoreAllMocks());

  it('snapshots a recorded mutable, so restore undoes an in-place write and notifies', () => {
    const list = mutable([1, 2]);
    let runs = 0;
    const sum = computed(() => {
      runs++;
      return list().reduce((a, b) => a + b, 0);
    });
    expect(sum()).toBe(3);

    const txn = createTransaction();
    txn.record(list as WritableSignal<unknown>);
    list.mutate((a) => {
      a.push(3);
      return a;
    });
    const mutated = list();
    expect(sum()).toBe(6);

    txn.restore();
    expect(list()).toEqual([1, 2]);
    expect(list()).not.toBe(mutated);
    expect(sum()).toBe(3);
    expect(runs).toBe(3);
  });

  it('restores a recorded mutable written with set', () => {
    const obj = mutable({ a: 1 });
    const txn = createTransaction();
    txn.record(obj as WritableSignal<unknown>);
    obj.set({ a: 2 });
    txn.restore();
    expect(obj()).toEqual({ a: 1 });
  });

  it('records a plain signal by reference, without cloning', () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const value = { a: 1 };
    const plain = signal(value);
    const txn = createTransaction();
    txn.record(plain as WritableSignal<unknown>);
    plain.set({ a: 2 });
    txn.restore();
    expect(plain()).toBe(value);
    expect(clone).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when a recorded mutable holds an uncloneable value', () => {
    const holder = mutable<{ fn: () => number }>({ fn: () => 1 });
    const txn = createTransaction();
    expect(() => txn.record(holder as WritableSignal<unknown>)).toThrow(
      'transaction: a mutable signal holding a value that cannot be cloned cannot be recorded for rollback; hold plain data or write it through a plain signal',
    );
  });

  it('does not roll back an unrecorded mutate inside a transaction body', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const list = mutable([1]);

    const t = host.start(() => {
      list.inline((a) => a.push(2));
      host.ref.status.set('loading');
    });
    t.abort();

    expect(list()).toEqual([1, 2]);
    expect(clone).not.toHaveBeenCalled();
  });

  it('keeps resources registered inside a transaction body after abort', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const first = makeRef('loading');
    const second = makeRef('loading');

    const t = host.start(() => {
      host.scope.add(first, { suspends: false });
      host.scope.add(second, { suspends: false });
    });
    expect(() => t.abort()).not.toThrow();

    expect(host.scope.resources()).toContain(first);
    expect(host.scope.resources()).toContain(second);
    expect(host.scope.pending()).toBe(true);
  });
});

describe('retain: the continuous hold', () => {
  const flush = async (fixture: { detectChanges(): void }) => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };

  it('a retain keeps a no-async transaction open past the first render until released', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.display()).toBe(1);

    let release!: () => void;
    const t = host.start((tx) => {
      host.write(2);
      release = tx.retain();
    });
    let resolved = false;
    void t.done.then(() => (resolved = true));
    await flush(fixture);

    expect(resolved).toBe(false);
    expect(host.scope.holding()).toBe(true);
    expect(host.display()).toBe(1); // still held past the render that used to commit it

    release();
    release(); // idempotent
    await flush(fixture);
    expect(resolved).toBe(true);
    expect(host.scope.holding()).toBe(false);
    expect(host.display()).toBe(2);
  });

  it('every retain must be released; attributed pending and retains compose', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.display()).toBe(1); // baseline read before the txn
    const releases: (() => void)[] = [];
    const t = host.start((tx) => {
      host.write(2);
      releases.push(tx.retain(), tx.retain());
      host.ref.status.set('loading');
    });
    let resolved = false;
    void t.done.then(() => (resolved = true));

    host.ref.status.set('resolved'); // the load drains, two retains still open
    await flush(fixture);
    releases[0]();
    await flush(fixture);
    expect([resolved, host.display()]).toEqual([false, 1]);

    releases[1]();
    await flush(fixture);
    expect([resolved, host.display()]).toEqual([true, 2]);
  });

  it('abort ignores open retains: restores, releases and settles at once', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    let tx!: Transaction;
    const t = host.start((x) => {
      tx = x;
      host.write(2);
      x.retain();
    });
    let resolved = false;
    void t.done.then(() => (resolved = true));
    t.abort();
    await flush(fixture);
    expect([resolved, host.state(), host.scope.holding(), tx.closed]).toEqual([
      true,
      1,
      false,
      true,
    ]);
    expect(() => tx.retain()).toThrow('closed transaction');
  });

  it('a retain held across an await: enter records the late write into the same transaction', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    expect(host.display()).toBe(1); // baseline read before the txn
    let tx!: Transaction;
    let release!: () => void;
    const t = host.start((x) => {
      tx = x;
      release = x.retain();
    });
    await flush(fixture);
    tx.enter(() => host.write(3)); // the slice after the await
    expect(host.display()).toBe(1);
    t.abort();
    release();
    await flush(fixture);
    expect(host.state()).toBe(1); // the late write was recorded and undone
  });

  it('on the server a retain defers the commit to its release', async () => {
    const { fixture } = await render(Host, {
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const host = fixture.componentInstance;
    let release!: () => void;
    const t = host.start((tx) => {
      host.write(5);
      release = tx.retain();
    });
    let resolved = false;
    void t.done.then(() => (resolved = true));
    await flush(fixture);
    expect(resolved).toBe(false);
    release();
    await flush(fixture);
    expect(resolved).toBe(true);
    expect(host.display()).toBe(5);
  });
});

describe('slice claims through startTransaction', () => {
  it('a load started inside A body is A own work, not B, though B started first', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const loads = signal(0);
    const res = Object.assign(makeRef('resolved'), { loads });
    host.scope.add(res, { suspends: false });
    const kickoff = () => {
      res.status.set('loading');
      loads.update((n) => n + 1);
    };

    let bTx!: Transaction;
    const b = host.start((tx) => {
      bTx = tx;
      tx.retain();
    });
    const a = host.start(() => kickoff());
    expect([a.pending(), b.pending()]).toEqual([true, false]);

    // a later kickoff inside B's re-entered slice is B's, and still not A's after A settles
    res.status.set('resolved');
    fixture.detectChanges();
    bTx.enter(kickoff);
    expect([a.pending(), b.pending()]).toEqual([false, true]);

    // outside any slice: started since both checkpoints, so both see it
    res.status.set('resolved');
    kickoff();
    expect([a.pending(), b.pending()]).toEqual([true, true]);
    b.abort();
    a.abort();
  });
});

// ─── mid-hold readers: seeded from the ledger ──────────────────────────────────────────

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'seed-child',
  template: `{{ view() }}`,
})
class SeedChild {
  private readonly host = inject(SeedHost);
  private readonly scope = injectTransitionScope();
  readonly count = this.scope.hold(this.host.count);
  readonly plain = this.scope.hold(this.host.plain);
  runs = 0;
  readonly view = computed(() => {
    this.runs++;
    return `${this.count()}|${this.plain()}`;
  });
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'seed-host',
  imports: [SeedChild],
  template: `@if (show()) {
    <seed-child />
  }`,
  providers: [provideTransitionScope()],
})
class SeedHost {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly ref = makeRef('resolved');
  readonly count = transactional(signal(1));
  readonly plain = signal(10);
  readonly show = signal(false);
  /** a held reader that existed before any transaction: the rest of the page */
  readonly page = this.scope.hold(this.count);
  constructor() {
    this.scope.add(this.ref, { suspends: false });
  }
}

describe('a view mounted while a transaction holds', () => {
  const flush = async (fixture: { detectChanges(): void }) => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const text = (el: HTMLElement) => el.textContent?.trim() ?? '';

  it('shows the pre-transaction value of a recorded signal, the live value of an unrecorded one, and reveals live at commit', async () => {
    const { fixture, container } = await render(SeedHost);
    const host = fixture.componentInstance;
    expect(host.page()).toBe(1);

    host.start(() => {
      host.count.set(2);
      host.plain.set(11); // not recorded: the documented limit
      host.ref.status.set('loading');
    });
    host.show.set(true);
    await flush(fixture);
    const child = fixture.debugElement.children[0]
      .componentInstance as SeedChild;
    expect([text(container), host.page(), child.runs]).toEqual(['1|11', 1, 1]);

    host.count.set(3); // a later live write while held: no recomputation of the view
    await flush(fixture);
    expect([text(container), child.runs]).toEqual(['1|11', 1]);

    host.ref.status.set('resolved');
    await flush(fixture);
    expect([text(container), host.page(), child.runs]).toEqual(['3|11', 3, 2]);
  });

  it('across an abort the mounted view shows the pre value throughout: no flash, no recomputation', async () => {
    const { fixture, container } = await render(SeedHost);
    const host = fixture.componentInstance;
    expect(host.page()).toBe(1);

    const t = host.start(() => {
      host.count.set(2);
      host.ref.status.set('loading');
    });
    host.show.set(true);
    await flush(fixture);
    const child = fixture.debugElement.children[0]
      .componentInstance as SeedChild;
    const frames = [text(container)];
    t.abort();
    frames.push(text(container));
    await flush(fixture);
    frames.push(text(container));
    expect([frames, host.count(), host.scope.holding(), child.runs]).toEqual([
      ['1|10', '1|10', '1|10'],
      1,
      false,
      1,
    ]);
  });

  it('two holding transactions: the first recorded write gives the pre', async () => {
    const { fixture, container } = await render(SeedHost);
    const host = fixture.componentInstance;
    expect(host.page()).toBe(1);
    const releases: (() => void)[] = [];
    host.start((tx) => {
      host.count.set(2);
      releases.push(tx.retain());
    });
    host.start((tx) => {
      host.count.set(3);
      releases.push(tx.retain());
    });
    host.show.set(true);
    await flush(fixture);
    expect([text(container), host.page()]).toEqual(['1|10', 1]);
    releases[0]();
    await flush(fixture);
    expect([text(container), host.scope.holding()]).toEqual(['1|10', true]);
    releases[1]();
    await flush(fixture);
    expect([text(container), host.page()]).toEqual(['3|10', 3]);
  });

  it('cross-order: the older transaction records over a younger one; the seed is still the value before both', async () => {
    const { fixture, container } = await render(SeedHost);
    const host = fixture.componentInstance;
    expect(host.page()).toBe(1);
    let older!: Transaction;
    const releases: (() => void)[] = [];
    host.start((tx) => {
      older = tx;
      releases.push(tx.retain());
    });
    host.start((tx) => {
      host.count.set(2);
      releases.push(tx.retain());
    });
    older.enter(() => host.count.set(3));
    host.show.set(true);
    await flush(fixture);
    expect([text(container), host.page()]).toEqual(['1|10', 1]);
    releases.forEach((r) => r());
    await flush(fixture);
    expect(text(container)).toBe('3|10');
  });

  it('a transaction that settled inside the hold still seeds until the hold ends; after it, a new reader reads live', async () => {
    const { fixture, container } = await render(SeedHost);
    const host = fixture.componentInstance;
    expect(host.page()).toBe(1);
    let releaseA!: () => void;
    let releaseB!: () => void;
    host.start((tx) => {
      host.count.set(2);
      releaseA = tx.retain();
    });
    host.start((tx) => {
      releaseB = tx.retain(); // holds, records nothing
    });
    releaseA();
    await flush(fixture);
    expect(host.scope.holding()).toBe(true);
    host.show.set(true);
    await flush(fixture);
    // A committed, B still holds: the new view joins the held page
    expect([text(container), host.page()]).toEqual(['1|10', 1]);
    releaseB();
    host.show.set(false);
    await flush(fixture);
    host.show.set(true);
    await flush(fixture);
    expect([text(container), host.page(), host.scope.holding()]).toEqual([
      '2|10',
      2,
      false,
    ]);
  });
});

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'nested-boundary',
  template: ``,
  providers: [provideTransitionScope()],
})
class NestedBoundary {
  readonly scope = injectTransitionScope();
  readonly ref = makeRef('resolved');
  constructor() {
    this.scope.add(this.ref, { suspends: false });
  }
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'outer-page',
  imports: [NestedBoundary],
  template: `<nested-boundary />`,
  providers: [provideTransitionScope()],
})
class OuterPage {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly ref = makeRef('resolved');
  constructor() {
    this.scope.add(this.ref, { suspends: false });
  }
}

describe('a hold on a scope holds the scopes created inside it', () => {
  it('a nested boundary scope reports holding while the page holds; its pending stays its own', async () => {
    const { fixture } = await render(OuterPage);
    const page = fixture.componentInstance;
    const nested = fixture.debugElement.children[0]
      .componentInstance as NestedBoundary;
    expect([nested.scope.holding(), nested.scope.pending()]).toEqual([
      false,
      false,
    ]);

    let release!: () => void;
    page.start((tx) => {
      release = tx.retain();
    });
    page.ref.status.set('loading');
    expect([
      page.scope.holding(),
      nested.scope.holding(),
      page.scope.pending(),
      nested.scope.pending(),
    ]).toEqual([true, true, true, false]);

    nested.ref.status.set('loading');
    page.ref.status.set('resolved');
    expect([nested.scope.pending(), page.scope.pending()]).toEqual([
      true,
      false,
    ]);

    release();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect([page.scope.holding(), nested.scope.holding()]).toEqual([
      false,
      false,
    ]);
    nested.ref.status.set('resolved');
  });

  it('a hold on the nested scope does not hold the page', async () => {
    const { fixture } = await render(OuterPage);
    const page = fixture.componentInstance;
    const nested = fixture.debugElement.children[0]
      .componentInstance as NestedBoundary;
    nested.scope.beginHold();
    expect([page.scope.holding(), nested.scope.holding()]).toEqual([
      false,
      true,
    ]);
    nested.scope.endHold();
  });
});

// ─── seeds across scopes and hold episodes ─────────────────────────────────────────────

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'chain-reader',
  template: `{{ view() }}`,
})
class ChainReader {
  readonly shown = injectTransitionScope().hold(inject(ChainPage).s);
  runs = 0;
  readonly view = computed(() => {
    this.runs++;
    return `r:${this.shown()}`;
  });
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'chain-boundary',
  imports: [ChainReader],
  template: `@if (show()) {
    <chain-reader />
  }`,
  providers: [provideTransitionScope()],
})
class ChainBoundary {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly show = signal(false);
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'chain-page',
  imports: [ChainBoundary],
  template: `<chain-boundary />`,
  providers: [provideTransitionScope()],
})
class ChainPage {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly s = transactional(signal(1));
  readonly page = this.scope.hold(this.s);
}

describe('seeds across scopes and hold episodes', () => {
  const flush = async (fixture: { detectChanges(): void }) => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
    fixture.detectChanges();
  };
  const setup = async () => {
    const r = await render(ChainPage);
    const page = r.fixture.componentInstance;
    const boundary = r.fixture.debugElement.children[0]
      .componentInstance as ChainBoundary;
    expect(page.page()).toBe(1);
    return { ...r, page, boundary };
  };
  const text = (el: HTMLElement) => el.textContent?.trim() ?? '';

  it('a transaction on the child scope that settles under the page hold still seeds a reader mounted after it; the page release reveals live', async () => {
    const { fixture, container, page, boundary } = await setup();
    let releasePage!: () => void;
    page.start((tx) => {
      releasePage = tx.retain();
    });
    const t = boundary.start(() => page.s.set(2)); // the child scope's own transaction
    let settled = false;
    void t.done.then(() => (settled = true));
    await flush(fixture);
    expect([
      settled,
      page.scope.holding(),
      boundary.scope.holding(),
      page.s(),
    ]).toEqual([true, true, true, 2]);

    boundary.show.set(true);
    await flush(fixture);
    const reader = fixture.debugElement.query(
      (d) => d.componentInstance instanceof ChainReader,
    ).componentInstance as ChainReader;
    expect([text(container), page.page(), reader.runs]).toEqual(['r:1', 1, 1]);

    releasePage();
    await flush(fixture);
    expect([
      text(container),
      page.page(),
      boundary.scope.holding(),
      reader.runs,
    ]).toEqual(['r:2', 2, false, 2]);
  });

  it('a later hold never seeds from an earlier one: the second episode seeds from its own transaction', async () => {
    const { fixture, container, page, boundary } = await setup();
    // episode 1: the page holds, a child transaction X writes 1 → 2 and settles under it
    let releasePage!: () => void;
    page.start((tx) => {
      releasePage = tx.retain();
    });
    boundary.start(() => page.s.set(2));
    await flush(fixture);
    releasePage();
    await flush(fixture);
    expect([page.page(), page.scope.holding()]).toEqual([2, false]);

    // episode 2: the page holds again, Y writes 2 → 3; X's kept seed (pre 1) must not win
    let releaseY!: () => void;
    page.start((tx) => {
      page.s.set(3);
      releaseY = tx.retain();
    });
    boundary.show.set(true);
    await flush(fixture);
    expect([text(container), page.page()]).toEqual(['r:2', 2]);
    releaseY();
    await flush(fixture);
    expect(text(container)).toBe('r:3');
  });

  it('after a hold ends, a new hold that records nothing seeds nothing: a reader mounted in it reads live', async () => {
    const { fixture, container, page, boundary } = await setup();
    let release!: () => void;
    boundary.start((tx) => {
      page.s.set(2);
      release = tx.retain();
    });
    await flush(fixture);
    release();
    await flush(fixture);
    expect(boundary.scope.holding()).toBe(false);

    let releaseAgain!: () => void;
    boundary.start((tx) => {
      releaseAgain = tx.retain();
    });
    boundary.show.set(true);
    await flush(fixture);
    expect([text(container), boundary.scope.holding()]).toEqual(['r:2', true]);
    releaseAgain();
    await flush(fixture);
    expect(text(container)).toBe('r:2');
  });
});

describe('after every hold in the tree ends', () => {
  it('a reader mounted then reads live and the registry is empty', async () => {
    const r = await render(ChainPage);
    const page = r.fixture.componentInstance;
    const boundary = r.fixture.debugElement.children[0]
      .componentInstance as ChainBoundary;
    const flush = async () => {
      for (let i = 0; i < 4; i++) {
        r.fixture.detectChanges();
        await Promise.resolve();
        await new Promise((res) => setTimeout(res));
      }
      r.fixture.detectChanges();
    };
    expect(page.page()).toBe(1);
    let releasePage!: () => void;
    let releaseChild!: () => void;
    page.start((tx) => {
      page.s.set(2);
      releasePage = tx.retain();
    });
    boundary.start((tx) => {
      page.s.set(3);
      releaseChild = tx.retain();
    });
    expect(holdRegistrySize()).toBeGreaterThan(0);
    releasePage();
    await flush();
    expect(holdRegistrySize()).toBeGreaterThan(0); // the child still holds
    releaseChild();
    await flush();
    expect([
      page.scope.holding(),
      boundary.scope.holding(),
      holdRegistrySize(),
    ]).toEqual([false, false, 0]);
    boundary.show.set(true);
    await flush();
    expect(r.container.textContent?.trim()).toBe('r:3');
  });
});

describe('a scope destroyed while it holds', () => {
  it('ends its own hold, so the registry is cleared once nothing else holds', async () => {
    const r = await render(ChainPage);
    const page = r.fixture.componentInstance;
    page.scope.beginHold(); // never ended by hand
    page.start(() => page.s.set(2));
    expect(holdRegistrySize()).toBeGreaterThan(0);
    r.fixture.destroy();
    expect(holdRegistrySize()).toBe(0);
  });
});

// ─── reclamation under overlapping unrelated holds ─────────────────────────────────────

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'sib-reader',
  template: `{{ shown() }}`,
})
class SibReader {
  readonly shown = injectTransitionScope().hold(inject(SibHost).s);
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'sib-area',
  imports: [SibReader],
  template: `@if (show()) {
    <sib-reader />
  }`,
  providers: [provideTransitionScope()],
})
class SibArea {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly show = signal(false);
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'sib-host',
  imports: [SibArea],
  template: `<sib-area class="x" /><sib-area class="y" />`,
})
class SibHost {
  readonly s = transactional(signal(0));
}

describe('two unrelated areas alternating overlapping saves', () => {
  it('20 rounds: the registry never exceeds the entries of the live stretches, and a reader mounted each round shows its area pre', async () => {
    const { fixture } = await render(SibHost);
    const host = fixture.componentInstance;
    const [x, y] = fixture.debugElement.children.map(
      (d) => d.componentInstance as SibArea,
    );
    const flush = async () => {
      for (let i = 0; i < 4; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };
    const textOf = (a: SibArea) =>
      (
        fixture.debugElement.children[a === x ? 0 : 1]
          .nativeElement as HTMLElement
      ).textContent?.trim() ?? '';

    let release = (() => undefined) as () => void;
    const sizes: number[] = [];
    const shown: string[] = [];
    for (let round = 1; round <= 20; round++) {
      const area = round % 2 ? x : y;
      let next!: () => void;
      area.start((tx) => {
        host.s.set(round); // writes on top of the other area's still-held save
        next = tx.retain();
      });
      release(); // the other area's save ends while this one holds: never zero holds
      await flush();
      sizes.push(holdRegistrySize());
      area.show.set(true);
      await flush();
      shown.push(textOf(area));
      area.show.set(false);
      release = next;
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1);
    expect(shown).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i)), // the value before the area's own write
    );
    release();
    await flush();
    expect(holdRegistrySize()).toBe(0);
  });
});
