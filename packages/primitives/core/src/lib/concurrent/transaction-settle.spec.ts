import {
  Component,
  computed,
  signal,
  type ResourceRef,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { injectStartTransition } from './start-transition';
import { activeTransaction, injectStartTransaction } from './transaction';
import {
  injectTransitionScope,
  provideTransitionScope,
} from './transition-scope';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  loads: WritableSignal<number>;
};

function makeRef(status: ResourceStatus = 'resolved'): FakeRef {
  const status$ = signal<ResourceStatus>(status);
  return {
    status: status$,
    value: signal(1),
    isLoading: computed(
      () => status$() === 'loading' || status$() === 'reloading',
    ),
    hasValue: () => true,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
    loads: signal(0),
  } as unknown as FakeRef;
}

const kickoff = (r: FakeRef, status: ResourceStatus = 'loading') => {
  r.status.set(status);
  r.loads.update((n) => n + 1);
};

@Component({
  selector: 'settle-host',
  template: ``,
  providers: [provideTransitionScope()],
})
class Host {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly startTransition = injectStartTransition();
  readonly ref = makeRef();
  readonly other = makeRef();
  readonly state = signal(1);
  readonly display = this.scope.hold(computed(() => this.state()));
  constructor() {
    this.scope.add(this.ref, { suspends: false });
    this.scope.add(this.other, { suspends: false });
  }
  write(v: number) {
    activeTransaction()?.record(
      this.state as unknown as WritableSignal<unknown>,
    );
    this.state.set(v);
  }
}

const flush = async (fixture: { detectChanges(): void }) => {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  fixture.detectChanges();
};

describe('a settled transaction is not pending again', () => {
  it('sync startTransaction: a load started after it committed does not reopen pending', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    const t = host.start(() => {
      host.write(2);
      kickoff(host.ref);
    });
    expect(t.pending()).toBe(true);
    host.ref.status.set('resolved');
    await flush(fixture);
    let done = false;
    await t.done.then(() => (done = true));
    expect(done).toBe(true);
    expect(t.pending()).toBe(false);

    kickoff(host.other);
    expect(t.pending()).toBe(false);
    await flush(fixture);
    expect(t.pending()).toBe(false);
    host.other.status.set('resolved');
  });

  it('sync startTransaction: after abort, a load the restore restarts does not reopen pending', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    const t = host.start(() => kickoff(host.ref));
    t.abort();
    expect(t.pending()).toBe(false);
    kickoff(host.other);
    expect(t.pending()).toBe(false);
  });

  it('startTransition: a load started after done resolved does not reopen pending', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    const t = host.startTransition(() => kickoff(host.ref));
    expect(t.pending()).toBe(true);
    host.ref.status.set('resolved');
    await flush(fixture);
    await t.done;
    expect(t.pending()).toBe(false);

    kickoff(host.other);
    expect(t.pending()).toBe(false);
  });

  it('two open transactions both see a load started outside any slice; a settled one does not', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    let releaseB!: () => void;
    const b = host.start((tx) => {
      releaseB = tx.retain();
    });
    const a = host.start(() => kickoff(host.ref));
    host.ref.status.set('resolved');
    await flush(fixture);
    await a.done;

    kickoff(host.other);
    expect([a.pending(), b.pending()]).toEqual([false, true]);
    host.other.status.set('resolved');
    releaseB();
    await flush(fixture);
    await b.done;
    expect(b.pending()).toBe(false);
  });
});

describe('a body that ends its own transaction', () => {
  it('a load the body started stays its own: another open transaction does not adopt it', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    let releaseB!: () => void;
    const b = host.start((tx) => {
      releaseB = tx.retain();
    });
    const a = host.start(() => {
      kickoff(host.ref);
      host.start(() => undefined).abort();
    });
    expect(a.pending()).toBe(false);
    expect(b.pending()).toBe(false);
    await flush(fixture);
    expect(b.pending()).toBe(false);

    host.ref.status.set('resolved');
    releaseB();
    await flush(fixture);
    await b.done;
  });

  it('settles once and keeps working after the body aborted it', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;

    let outcomes = 0;
    const a = host.start(() => {
      host.write(2);
      host.start(() => undefined).abort();
    });
    void a.done.then(() => outcomes++);
    await flush(fixture);
    expect(outcomes).toBe(1);
    expect(host.state()).toBe(1);
    expect(host.display()).toBe(1);

    host.state.set(3);
    await flush(fixture);
    expect(host.display()).toBe(3);
  });
});
