/* eslint-disable @angular-eslint/component-selector */
import {
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
import { registerResource } from './transition-scope';

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
