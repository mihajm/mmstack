/* eslint-disable @angular-eslint/component-selector */
import {
  afterNextRender,
  Component,
  computed,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { MmTransition } from './transition';
import { UnscopedSuspenseBoundary } from './suspense-boundary';
import {
  injectStartTransaction,
  injectTransitionScope,
  provideTransitionScope,
  registerResource,
  transactional,
} from '@mmstack/primitives/core';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
  value: WritableSignal<unknown>;
};

function makeRef(status: ResourceStatus, value: unknown): FakeRef {
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
  } as unknown as FakeRef;
}

const REF_B = new InjectionToken<FakeRef>('ref-b');
const REF_C = new InjectionToken<FakeRef>('ref-c');

@Component({ selector: 'branch-a', template: `branch-a` })
class BranchA {}

@Component({ selector: 'branch-b', template: `branch-b` })
class BranchB {
  constructor() {
    registerResource(inject(REF_B), { suspends: false });
  }
}

@Component({ selector: 'branch-c', template: `branch-c` })
class BranchC {
  constructor() {
    registerResource(inject(REF_C), { suspends: false });
  }
}

// loads nothing — exercises the afterNextRender fallback
@Component({ selector: 'branch-d', template: `branch-d` })
class BranchD {}

@Component({
  selector: 'tr-host',
  imports: [MmTransition, BranchA, BranchB, BranchC, BranchD],
  template: `
    <div class="wrap" *mmTransition="tab(); let t">
      @switch (t) {
        @case ('a') {
          <branch-a />
        }
        @case ('b') {
          <branch-b />
        }
        @case ('c') {
          <branch-c />
        }
        @case ('d') {
          <branch-d />
        }
      }
    </div>
  `,
})
class Host {
  readonly tab = signal('a');
}

@Component({
  selector: 'tr-loading-host',
  imports: [MmTransition, BranchB],
  template: `
    <div class="wrap" *mmTransition="tab(); let t">
      @if (t === 'b') {
        <branch-b />
      }
    </div>
  `,
})
class StartsLoadingHost {
  readonly tab = signal('b');
}

@Component({
  selector: 'tr-imm-host',
  imports: [MmTransition, BranchA, BranchB],
  template: `
    <div class="wrap" *mmTransition="tab(); immediate: true; let t">
      @switch (t) {
        @case ('a') {
          <branch-a />
        }
        @case ('b') {
          <branch-b />
        }
      }
    </div>
  `,
})
class ImmediateHost {
  readonly tab = signal('a');
}

const flush = async (detect: () => void) => {
  for (let i = 0; i < 5; i++) {
    detect();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
  }
  detect();
};

/** Text of only the VISIBLE transitioned views (the hidden incoming one is display:none). */
function visibleText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>('.wrap'))
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.textContent?.trim() ?? '')
    .join('|');
}

describe('MmTransition (hold-and-swap)', () => {
  it('first render is immediate — even a still-loading branch shows right away (nothing to hold)', async () => {
    const refB = makeRef('loading', undefined);
    const { fixture, container } = await render(StartsLoadingHost, {
      providers: [{ provide: REF_B, useValue: refB }],
    });
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-b'); // visible despite loading
  });

  it('holds the old branch until the incoming branch settles, then swaps', async () => {
    const refB = makeRef('loading', undefined);
    const { fixture, container } = await render(Host, {
      providers: [{ provide: REF_B, useValue: refB }],
    });
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-a');

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());

    // incoming registered into its per-view scope and is loading → old branch stays visible
    expect(visibleText(container)).toBe('branch-a');
    expect(container.textContent).toContain('branch-b'); // mounted, hidden

    refB.status.set('resolved');
    refB.value.set({ ok: true });
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-b');
    expect(container.textContent).not.toContain('branch-a'); // old view destroyed
  });

  it('a branch that loads nothing swaps via the render fallback', async () => {
    const { fixture, container } = await render(Host, {
      providers: [{ provide: REF_B, useValue: makeRef('loading', undefined) }],
    });
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('d');
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-d');
    expect(container.textContent).not.toContain('branch-a');
  });

  it('an interrupting change destroys the half-ready view and re-targets the hold', async () => {
    const refB = makeRef('loading', undefined);
    const refC = makeRef('loading', undefined);
    const { fixture, container } = await render(Host, {
      providers: [
        { provide: REF_B, useValue: refB },
        { provide: REF_C, useValue: refC },
      ],
    });
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    fixture.componentInstance.tab.set('c'); // interrupt while b is still loading
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-a'); // stable view still visible
    expect(container.textContent).not.toContain('branch-b'); // superseded view destroyed

    refB.status.set('resolved'); // the superseded branch settling must do nothing
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-a');

    refC.status.set('resolved');
    refC.value.set({ ok: true });
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-c');
  });

  it("the outgoing branch's background work cannot delay the swap (per-view scopes)", async () => {
    const refB = makeRef('resolved', { ok: true });
    const { fixture, container } = await render(Host, {
      providers: [{ provide: REF_B, useValue: refB }],
    });
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-b');

    refB.status.set('reloading'); // outgoing view starts background work…
    fixture.componentInstance.tab.set('d'); // …while we leave it
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-d'); // swapped anyway
  });

  it('immediate mode swaps at once, even mid-load', async () => {
    const refB = makeRef('loading', undefined);
    const { fixture, container } = await render(ImmediateHost, {
      providers: [{ provide: REF_B, useValue: refB }],
    });
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-a');

    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('branch-b'); // no hold
    expect(container.textContent).not.toContain('branch-a');
  });
});

// ── A5: hold-and-swap under error ────────────────────────────────────────────
// The incoming branch's only suspending resource FAILS while the branch is held hidden. An
// errored member is not pending, so the hold releases and the branch shows its own error UI;
// holding the stale branch on error would be the placeholder-forever bug again.
const REF_E = new InjectionToken<FakeRef>('ref-e');

@Component({
  selector: 'branch-e',
  imports: [UnscopedSuspenseBoundary],
  template: `
    <mm-unscoped-suspense>
      <span>e-content</span>
      <span error>e-error</span>
    </mm-unscoped-suspense>
  `,
})
class BranchE {
  constructor() {
    registerResource(inject(REF_E)); // suspends (the default)
  }
}

@Component({
  selector: 'tr-error-host',
  imports: [MmTransition, BranchA, BranchE],
  template: `
    <div class="wrap" *mmTransition="tab(); let t">
      @switch (t) {
        @case ('a') {
          <branch-a />
        }
        @case ('e') {
          <branch-e />
        }
      }
    </div>
  `,
})
class ErrorHost {
  readonly tab = signal('a');
}

describe('MmTransition (A5: commit under error)', () => {
  it('a hidden incoming branch whose suspending resource fails commits and shows its own error UI', async () => {
    const refE = makeRef('loading', undefined);
    const { fixture, container } = await render(ErrorHost, {
      providers: [{ provide: REF_E, useValue: refE }],
    });
    await flush(() => fixture.detectChanges());

    fixture.componentInstance.tab.set('e');
    await flush(() => fixture.detectChanges());
    expect(visibleText(container)).toBe('branch-a'); // held while the incoming branch loads

    refE.status.set('error');
    await flush(() => fixture.detectChanges());

    expect(visibleText(container)).toBe('e-error');
    expect(container.textContent).not.toContain('branch-a'); // the stale branch is gone
    expect(container.textContent).not.toContain('e-content');
  });
});

// ─── the swap waits for an open hold on the incoming scope ─────────────────────────────

const RELEASES = new InjectionToken<(() => void)[]>('releases');

// holds its own (incoming) scope from construction until released; loads nothing
@Component({ selector: 'branch-held', template: `branch-held` })
class BranchHeld {
  constructor() {
    const releases = inject(RELEASES);
    injectStartTransaction()((tx) => {
      releases.push(tx.retain());
    });
  }
}

// a synchronous transaction opened by a component the branch mounts in its first update pass
@Component({ selector: 'late-txn', template: `` })
class LateTxn {
  constructor() {
    injectStartTransaction()(() => undefined);
  }
}

@Component({
  selector: 'branch-late',
  imports: [LateTxn],
  template: `@if (on) {
      <late-txn />
    }
    branch-late`,
})
class BranchLate {
  readonly on = true;
}

@Component({
  selector: 'tr-hold-host',
  imports: [MmTransition, BranchA, BranchHeld, BranchLate],
  template: `
    <div class="wrap" *mmTransition="tab(); let t">
      @switch (t) {
        @case ('a') {
          <branch-a />
        }
        @case ('held') {
          <branch-held />
        }
        @case ('late') {
          <branch-late />
        }
      }
    </div>
  `,
})
class HoldHost {
  readonly tab = signal('a');
}

describe('MmTransition (the swap waits for an open hold)', () => {
  const swaps = () =>
    vi.spyOn(
      MmTransition.prototype as unknown as { finishSwap: () => void },
      'finishSwap',
    );
  afterEach(() => vi.restoreAllMocks());

  it('an incoming branch with nothing pending under an open hold waits, then commits once at the release', async () => {
    const releases: (() => void)[] = [];
    const { fixture, container } = await render(HoldHost, {
      providers: [{ provide: RELEASES, useValue: releases }],
    });
    await flush(() => fixture.detectChanges());
    const spy = swaps();

    fixture.componentInstance.tab.set('held');
    await flush(() => fixture.detectChanges());
    await flush(() => fixture.detectChanges());
    expect([
      visibleText(container),
      releases.length,
      spy.mock.calls.length,
    ]).toEqual(['branch-a', 1, 0]);
    expect(container.textContent).toContain('branch-held'); // mounted, hidden

    releases[0]();
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), spy.mock.calls.length]).toEqual([
      'branch-held',
      1,
    ]);
    await flush(() => fixture.detectChanges());
    expect(spy.mock.calls.length).toBe(1);
  });

  it('a hold opened and closed inside the first render does not strand the swap; it commits once', async () => {
    const { fixture, container } = await render(HoldHost, {
      providers: [{ provide: RELEASES, useValue: [] }],
    });
    await flush(() => fixture.detectChanges());
    const spy = swaps();

    fixture.componentInstance.tab.set('late');
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), spy.mock.calls.length]).toEqual([
      'branch-late',
      1,
    ]);
    expect(container.textContent).not.toContain('branch-a');
  });
});

// a hold that opens in a render hook ahead of the swap fallback and closes right after the hooks
@Component({ selector: 'hook-hold', template: `` })
class HookHold {
  constructor() {
    const scope = injectTransitionScope();
    afterNextRender(() => {
      scope.beginHold();
      queueMicrotask(() => scope.endHold());
    });
  }
}

@Component({
  selector: 'tr-hook-host',
  imports: [MmTransition, HookHold],
  template: `
    <div class="wrap" *mmTransition="tab(); let t"><hook-hold />{{ t }}</div>
  `,
})
class HookHost {
  readonly tab = signal('a');
}

describe('MmTransition (a hold between two watcher runs)', () => {
  it('a hold that opens in a render hook ahead of the fallback and closes right after does not strand the swap', async () => {
    const spy = vi.spyOn(
      MmTransition.prototype as unknown as { finishSwap: () => void },
      'finishSwap',
    );
    const { fixture, container } = await render(HookHost);
    await flush(() => fixture.detectChanges());
    fixture.componentInstance.tab.set('b');
    await flush(() => fixture.detectChanges());
    expect([visibleText(container), spy.mock.calls.length]).toEqual(['b', 1]);
    spy.mockRestore();
  });
});

// ─── a transaction on an outer scope does not hold the incoming branch ─────────────────

@Component({ selector: 'outer-reader', template: `b:{{ shown() }}` })
class OuterReader {
  readonly shown = injectTransitionScope().hold(inject(OuterHost).count);
}

@Component({
  selector: 'tr-outer-host',
  imports: [MmTransition, OuterReader],
  template: `
    <div class="wrap" *mmTransition="tab(); let t">
      @if (t === 'b') {
        <outer-reader />
      } @else {
        branch-a
      }
    </div>
  `,
  providers: [provideTransitionScope()],
})
class OuterHost {
  readonly tab = signal('a');
  readonly start = injectStartTransaction();
  readonly scope = injectTransitionScope();
  readonly count = transactional(signal(1));
  readonly page = this.scope.hold(this.count);
}

describe('MmTransition under a transaction on the enclosing scope', () => {
  const setup = async () => {
    const spy = vi.spyOn(
      MmTransition.prototype as unknown as { finishSwap: () => void },
      'finishSwap',
    );
    const r = await render(OuterHost);
    const host = r.fixture.componentInstance;
    await flush(() => r.fixture.detectChanges());
    expect(host.page()).toBe(1);
    let release!: () => void;
    const t = host.start((tx) => {
      host.count.set(2);
      release = tx.retain();
    });
    host.tab.set('b');
    const frames: string[] = [];
    const step = async () => {
      await flush(() => r.fixture.detectChanges());
      frames.push(visibleText(r.container));
    };
    await step();
    await step();
    return { ...r, host, t, release, spy, frames, step };
  };
  afterEach(() => vi.restoreAllMocks());

  it('the incoming branch waits for the page hold, reads the pre value, and commits once at the release', async () => {
    const { host, release, spy, frames, step, container } = await setup();
    expect(frames).toEqual(['branch-a', 'branch-a']);
    expect([host.page(), host.scope.holding(), spy.mock.calls.length]).toEqual([
      1,
      true,
      0,
    ]);
    expect(container.textContent).toContain('b:1'); // mounted hidden, joined the held frame

    release();
    await step();
    await step();
    expect(frames.slice(2)).toEqual(['b:2', 'b:2']);
    expect([host.page(), spy.mock.calls.length]).toEqual([2, 1]);
  });

  it('an abort during the hold: the branch commits with the restored value and never shows the aborted write', async () => {
    const { host, t, spy, frames, step, container } = await setup();
    expect(container.textContent).toContain('b:1');
    t.abort();
    await step();
    await step();
    expect(frames).toEqual(['branch-a', 'branch-a', 'b:1', 'b:1']);
    expect([host.count(), spy.mock.calls.length]).toEqual([1, 1]);
    expect(container.textContent).not.toContain('b:2');
  });
});
