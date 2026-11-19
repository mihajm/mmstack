import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  inject,
  InjectionToken,
  PLATFORM_ID,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './transition-router-outlet';
import { injectVisualCommit } from './visual-commit';

type FakeRef = ResourceRef<unknown> & {
  status: WritableSignal<ResourceStatus>;
};

function makeRef(status: ResourceStatus): FakeRef {
  const status$ = signal<ResourceStatus>(status);
  return {
    status: status$,
    value: signal(undefined),
    isLoading: computed(() => status$() === 'loading'),
    hasValue: () => false,
    error: signal(undefined),
    reload: () => true,
    destroy: () => undefined,
  } as unknown as FakeRef;
}

const REFS = new InjectionToken<Record<string, FakeRef>>('vc-refs');
function track(name: string) {
  const ref = inject(REFS, { optional: true })?.[name];
  if (ref) registerResource(ref, { suspends: false });
}

@Component({ selector: 'page-a', template: `A` })
class PageA {
  constructor() {
    track('a');
  }
}
@Component({ selector: 'page-b', template: `B` })
class PageB {
  constructor() {
    track('b');
  }
}
@Component({ selector: 'child-one', template: `C1` })
class ChildOne {}
@Component({ selector: 'child-two', template: `C2` })
class ChildTwo {
  constructor() {
    track('c2');
  }
}
@Component({
  selector: 'parent-p',
  imports: [TransitionRouterOutlet],
  template: `P:<mm-transition-outlet />`,
})
class ParentP {}

const routes: Routes = [
  { path: 'a', component: PageA },
  { path: 'b', component: PageB },
  {
    path: 'p',
    component: ParentP,
    children: [
      { path: 'c1', component: ChildOne },
      { path: 'c2', component: ChildTwo },
    ],
  },
  { path: 'blocked', component: PageA, canActivate: [() => false] },
];

@Component({
  selector: 'vc-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

const flushOf = (fixture: { detectChanges: () => void }) => async () => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('visual commit contract', () => {
  it('tracks a navigation that started before anything injected the coordinator', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideLocationMocks()],
    });
    await TestBed.inject(Router).navigateByUrl('/a');

    const fixture = TestBed.createComponent(Host);
    const commit = TestBed.runInInjectionContext(() => injectVisualCommit());
    await flushOf(fixture)();
    expect(commit().status).toBe('committed');
    expect(commit().navigationId).not.toBeNull();
  });

  it('a superseded child hold with no follow-up activation leaves nothing outstanding', async () => {
    const c2 = makeRef('loading');
    const { fixture } = await render(Host, {
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        { provide: REFS, useValue: { c2 } },
      ],
    });
    const router = TestBed.inject(Router);
    const commit = TestBed.runInInjectionContext(() => injectVisualCommit());
    const flush = flushOf(fixture);

    await router.navigateByUrl('/p/c1');
    await flush();
    await router.navigateByUrl('/p/c2');
    await flush();
    await router.navigateByUrl('/p');
    await flush();
    expect(commit().status).toBe('committed');

    await router.navigateByUrl('/blocked');
    await flush();
    expect(commit()).toEqual({ status: 'idle', navigationId: null });
  });
});

describe('visual commit contract: server', () => {
  const g = globalThis as { ngServerMode?: boolean };
  let previous: boolean | undefined;
  beforeEach(() => {
    previous = g.ngServerMode;
    g.ngServerMode = true;
  });
  afterEach(() => {
    g.ngServerMode = previous;
  });

  it('NavigationEnd is the commit off the browser, even with an outlet armed', async () => {
    const b = makeRef('loading');
    const { fixture } = await render(Host, {
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: REFS, useValue: { b } },
      ],
    });
    const router = TestBed.inject(Router);
    const commit = TestBed.runInInjectionContext(() => injectVisualCommit());

    await router.navigateByUrl('/a');
    expect(commit().status).toBe('committed');
    await flushOf(fixture)();
    await router.navigateByUrl('/b');
    expect(commit().status).toBe('committed');
  });
});
