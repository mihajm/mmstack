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
import { SuspenseBoundary, UnscopedSuspenseBoundary } from './suspense-boundary';
import {
  injectTransitionScope,
  provideTransitionScope,
  registerResource,
  type TransitionScope,
} from './transition-scope';

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

const REF = new InjectionToken<FakeRef>('test-ref');

function ariaBusy(container: HTMLElement, sel: string): string | null {
  return container.querySelector(sel)?.getAttribute('aria-busy') ?? null;
}

// ── UnscopedSuspenseBoundary ────────────────────────────────────────────
// Host owns the (ambient) transition scope and registers the suspending resource
// into it; the unscoped boundary READS that ambient scope. This mirrors the
// app-builder, where connectors register at an injector above the page boundary.
@Component({
  selector: 'test-host',
  imports: [UnscopedSuspenseBoundary],
  providers: [provideTransitionScope()],
  template: `
    <mm-unscoped-suspense>
      <span class="real">real-content</span>
      <span placeholder class="ph">loading-placeholder</span>
    </mm-unscoped-suspense>
  `,
})
class UnscopedHost {
  constructor() {
    registerResource(inject(REF), { suspends: true });
  }
}

describe('UnscopedSuspenseBoundary (DOM)', () => {
  it('first load shows the placeholder, not the content', async () => {
    const ref = makeRef('loading', undefined);
    const { container } = await render(UnscopedHost, {
      providers: [{ provide: REF, useValue: ref }],
    });

    expect(container.textContent).toContain('loading-placeholder');
    expect(container.textContent).not.toContain('real-content');
  });

  it('once resolved, shows the content and is not busy', async () => {
    const ref = makeRef('resolved', { ok: true });
    const { container } = await render(UnscopedHost, {
      providers: [{ provide: REF, useValue: ref }],
    });

    expect(container.textContent).toContain('real-content');
    expect(container.textContent).not.toContain('loading-placeholder');
    expect(ariaBusy(container, 'mm-unscoped-suspense')).toBeNull();
  });

  it('on reload it HOLDS the content (keepPrevious) and marks aria-busy — no flash to placeholder', async () => {
    const ref = makeRef('resolved', { ok: true });
    const { container, fixture } = await render(UnscopedHost, {
      providers: [{ provide: REF, useValue: ref }],
    });

    expect(container.textContent).toContain('real-content');

    ref.status.set('reloading');
    fixture.detectChanges();

    expect(container.textContent).toContain('real-content'); // held — did NOT re-suspend
    expect(container.textContent).not.toContain('loading-placeholder');
    expect(ariaBusy(container, 'mm-unscoped-suspense')).toBe('true'); // transition indicator on
  });
});

// ── SuspenseBoundary (standalone, provides its own scope) ────────────────
// A child DECLARED inside <mm-suspense> has its ElementInjector parented to the
// boundary, so its registration lands in the boundary's OWN scope — no ancestor
// provideTransitionScope() needed. Registered `suspends:false` (the SWR/indicator
// path) so the content is always present to do the registering.
@Component({
  selector: 'inner-cmp',
  template: `<span class="real">real-content</span>`,
})
class Inner {
  constructor() {
    registerResource(inject(REF), { suspends: false });
  }
}

@Component({
  selector: 'scoped-host',
  imports: [SuspenseBoundary, Inner],
  template: `
    <mm-suspense>
      <inner-cmp />
    </mm-suspense>
  `,
})
class ScopedHost {}

// ── Injector-identity proof ────────────────────────────────────────────────
// The crux of "standalone <mm-suspense> just works": content written between its
// tags must read the boundary's OWN provided scope, not the ambient one. This proves
// it by injector identity — `providers` (unlike `viewProviders`) reach content children.
type Captured = { outside?: TransitionScope; inside?: TransitionScope };
const CAPTURED = new InjectionToken<Captured>('captured-scopes');

@Component({ selector: 'outside-probe', template: `` })
class OutsideProbe {
  constructor() {
    inject(CAPTURED).outside = injectTransitionScope();
  }
}

@Component({ selector: 'inside-probe', template: `` })
class InsideProbe {
  constructor() {
    inject(CAPTURED).inside = injectTransitionScope();
  }
}

@Component({
  selector: 'proj-host',
  imports: [SuspenseBoundary, OutsideProbe, InsideProbe],
  providers: [provideTransitionScope()], // an AMBIENT scope above the boundary
  template: `
    <outside-probe />
    <mm-suspense><inside-probe /></mm-suspense>
  `,
})
class ProjHost {}

describe('SuspenseBoundary scope reaches projected content', () => {
  it('projected content reads the boundary OWN scope, distinct from the ambient one', async () => {
    const captured: Captured = {};
    await render(ProjHost, { providers: [{ provide: CAPTURED, useValue: captured }] });

    expect(captured.outside).toBeDefined();
    expect(captured.inside).toBeDefined();
    // If projection did NOT inherit mm-suspense's providers, both would resolve to the
    // ambient scope and be identical. They differ → the projected child sees mm-suspense's
    // own scope (so `providers` reach content children; no ngTemplateOutlet workaround needed).
    expect(captured.inside).not.toBe(captured.outside);
  });
});

describe('SuspenseBoundary (standalone, own scope)', () => {
  it('captures a resource registered by content declared inside it — drives pending/hold', async () => {
    const ref = makeRef('resolved', { ok: true });
    const { container, fixture } = await render(ScopedHost, {
      providers: [{ provide: REF, useValue: ref }],
    });

    expect(container.textContent).toContain('real-content');
    expect(ariaBusy(container, 'mm-suspense')).toBeNull();

    ref.status.set('reloading');
    fixture.detectChanges();

    expect(container.textContent).toContain('real-content'); // held
    expect(ariaBusy(container, 'mm-suspense')).toBe('true'); // boundary saw the inner registration
  });
});
