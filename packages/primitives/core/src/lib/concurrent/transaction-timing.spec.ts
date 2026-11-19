import {
  Component,
  computed,
  effect,
  inject,
  PLATFORM_ID,
  signal,
  type ResourceStatus,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { injectStartTransition } from './start-transition';
import { injectStartTransaction, type TransactionOutcome } from './transaction';
import {
  injectTransitionScope,
  provideTransitionScope,
  type ResourceLike,
} from './transition-scope';

type Flight = ResourceLike & {
  status: WritableSignal<ResourceStatus>;
  loads: WritableSignal<number>;
};
function flight(): Flight {
  const status = signal<ResourceStatus>('resolved');
  return {
    status,
    isLoading: computed(() => status() === 'loading'),
    hasValue: () => true,
    loads: signal(0),
  };
}
const kick = (f: Flight) => {
  f.loads.update((n) => n + 1);
  f.status.set('loading');
};

/** A child whose view effect starts a load once it sees the write: work going in flight during the first render. */
@Component({ selector: 'tt-child', template: `` })
class Child {
  constructor() {
    const host = inject(Host);
    effect(() => {
      if (host.state() === 2) kick(host.f);
    });
  }
}

@Component({
  selector: 'tt-host',
  imports: [Child],
  template: `<tt-child />`,
  providers: [provideTransitionScope()],
})
class Host {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransaction();
  readonly startTransition = injectStartTransition();
  readonly state = signal(1);
  readonly f = flight();
  constructor() {
    this.scope.add(this.f, { suspends: false });
  }
}

async function setup(server = false) {
  const { fixture } = await render(Host, {
    providers: server ? [{ provide: PLATFORM_ID, useValue: 'server' }] : [],
  });
  const host = fixture.componentInstance;
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r));
    }
  };
  const tracked = <T>(p: Promise<T>) => {
    const box: { done: boolean; value?: T } = { done: false };
    void p.then((v) => {
      box.done = true;
      box.value = v;
    });
    return box;
  };
  return { host, flush, tracked };
}

describe('sync transaction: work that goes in flight by the first post-write render', () => {
  it('a load started during the first render belongs to it, so abort undoes the write', async () => {
    const { host, flush } = await setup();
    const t = host.start((tx) => tx.set(host.state, 2));
    await flush();
    expect(t.pending()).toBe(true);
    t.abort();
    expect(host.state()).toBe(1);
  });

  it('a load started right after start, before any render, belongs to it', async () => {
    const { host } = await setup();
    host.state.set(5);
    const t = host.start((tx) => tx.set(host.state, 6));
    kick(host.f);
    expect(t.pending()).toBe(true);
    t.abort();
    expect(host.state()).toBe(5);
  });

  it('startTransition awaits a load started during the first render', async () => {
    const { host, flush, tracked } = await setup();
    const t = host.startTransition(() => host.state.set(2));
    const done = tracked(t.done);
    await flush();
    expect(done.done).toBe(false);
    host.f.status.set('resolved');
    await flush();
    expect(done.done).toBe(true);
  });
});

describe('a sync outer seen through a nested async ref', () => {
  it('completes through the settle effect', async () => {
    const { host, flush, tracked } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let nested!: Promise<TransactionOutcome>;
    host.start(() => {
      nested = host.start(async () => gate).done;
    });
    const out = tracked(nested);
    await flush();
    release();
    await flush();
    expect(out.value).toEqual({ kind: 'completed' });
  });

  it('completes through the render fallback', async () => {
    const { host, flush, tracked } = await setup();
    let nested!: Promise<TransactionOutcome>;
    host.start(() => {
      nested = host.start(async () => undefined).done;
    });
    const out = tracked(nested);
    // the nested retain is released before the first render runs
    await Promise.resolve();
    await Promise.resolve();
    await flush();
    expect(out.value).toEqual({ kind: 'completed' });
  });

  it('an abort of the outer reads as abort', async () => {
    const { host, flush } = await setup();
    let nested!: Promise<TransactionOutcome>;
    const outer = host.start(() => {
      nested = host.start(() => new Promise<void>(() => undefined)).done;
    });
    outer.abort();
    await flush();
    await expect(nested).resolves.toEqual({ kind: 'aborted', reason: 'abort' });
  });
});

describe('on the server platform', () => {
  it('an async transaction waits for its retain and for its load', async () => {
    const { host, flush, tracked } = await setup(true);
    let release!: () => void;
    const held = tracked(
      host.start(async (tx) => {
        release = tx.retain();
      }).done,
    );
    await flush();
    expect(held.done).toBe(false);
    release();
    await flush();
    expect(held.value).toEqual({ kind: 'completed' });

    const loading = tracked(host.start(async () => kick(host.f)).done);
    await flush();
    expect(loading.done).toBe(false);
    host.f.status.set('resolved');
    await flush();
    expect(loading.value).toEqual({ kind: 'completed' });
  });

  it('a sync transaction and a transition wait for the load they started', async () => {
    const { host, flush, tracked } = await setup(true);
    const tx = tracked(host.start(() => kick(host.f)).done);
    await flush();
    expect(tx.done).toBe(false);
    host.f.status.set('resolved');
    await flush();
    expect(tx.done).toBe(true);

    const tr = tracked(host.startTransition(() => kick(host.f)).done);
    await flush();
    expect(tr.done).toBe(false);
    host.f.status.set('resolved');
    await flush();
    expect(tr.done).toBe(true);
  });
});

describe('in real server mode, where render hooks never run', () => {
  const g = globalThis as { ngServerMode?: boolean };
  it('sync and async transactions and a transition still settle', async () => {
    const { host, flush, tracked } = await setup(true);
    const before = g.ngServerMode;
    g.ngServerMode = true;
    try {
      const sync = tracked(host.start((tx) => tx.set(host.state, 7)).done);
      const asyncTx = tracked(
        host.start(async (tx) => tx.set(host.state, 8)).done,
      );
      const tr = tracked(host.startTransition(() => host.state.set(9)).done);
      await flush();
      expect([sync.done, asyncTx.value, tr.done]).toEqual([
        true,
        { kind: 'completed' },
        true,
      ]);
      expect(host.state()).toBe(9);
    } finally {
      g.ngServerMode = before;
    }
  });
});
