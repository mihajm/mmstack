import {
  Component,
  computed,
  PLATFORM_ID,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { render } from '@testing-library/angular';
import { injectStartTransition } from './start-transition';
import { injectTransitionScope, provideTransitionScope } from './transition-scope';

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

// eslint-disable-next-line @angular-eslint/component-selector
@Component({ selector: 'st-host', template: ``, providers: [provideTransitionScope()] })
class Host {
  readonly scope = injectTransitionScope();
  readonly start = injectStartTransition();
  readonly ref = makeRef('resolved');
  constructor() {
    this.scope.add(this.ref, { suspends: false });
  }
}

describe('injectStartTransition', () => {
  it('reports pending while the transition is in flight and resolves done on settle', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const flush = async () => {
      for (let i = 0; i < 4; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };

    // the transition triggers a reload (simulated by flipping the resource to loading)
    const t = host.start(() => host.ref.status.set('loading'));
    await flush();
    expect(t.pending()).toBe(true);

    let resolved = false;
    void t.done.then(() => (resolved = true));

    // settle → pending clears and done resolves
    host.ref.status.set('resolved');
    await flush();
    expect(t.pending()).toBe(false);
    expect(resolved).toBe(true);
  });

  it('resolves done for a no-async transition (nothing went in flight)', async () => {
    const { fixture } = await render(Host);
    const host = fixture.componentInstance;
    const flush = async () => {
      for (let i = 0; i < 4; i++) {
        fixture.detectChanges();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r));
      }
      fixture.detectChanges();
    };

    const t = host.start(() => {
      /* no reload triggered */
    });
    let resolved = false;
    void t.done.then(() => (resolved = true));
    await flush();
    expect(resolved).toBe(true); // afterNextRender fallback resolved it
  });

  it('resolves done on the server without afterNextRender (no-async transition)', async () => {
    const { fixture } = await render(Host, {
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    const host = fixture.componentInstance;

    const t = host.start(() => {
      /* no reload triggered */
    });
    await expect(t.done).resolves.toBeUndefined();
  });
});
