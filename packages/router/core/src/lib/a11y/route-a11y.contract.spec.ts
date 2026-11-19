import { provideLocationMocks } from '@angular/common/testing';
import {
  Component,
  computed,
  ErrorHandler,
  inject,
  InjectionToken,
  type ResourceRef,
  type ResourceStatus,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { createTitle } from '../title/title-store';
import { TransitionRouterOutlet } from '../transition-router-outlet';
import { injectVisualCommit } from '../visual-commit';
import { provideRouteA11y } from './route-a11y';

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

const REFS = new InjectionToken<Record<string, FakeRef>>('a11y-refs');
function track(name: string) {
  const ref = inject(REFS)[name];
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
@Component({ selector: 'page-imm', template: `IMM` })
class PageImm {
  constructor() {
    track('imm');
  }
}
@Component({ selector: 'page-tab', template: `TAB`, host: { tabindex: '0' } })
class PageTab {}
@Component({ selector: 'side-one', template: `S1` })
class SideOne {
  constructor() {
    track('s1');
  }
}
@Component({ selector: 'side-two', template: `S2` })
class SideTwo {
  constructor() {
    track('s2');
  }
}
@Component({ selector: 'side-three', template: `S3` })
class SideThree {
  constructor() {
    track('s3');
  }
}
@Component({ selector: 'child-one', template: `C1` })
class ChildOne {
  constructor() {
    track('c1');
  }
}
@Component({
  selector: 'parent-p',
  imports: [TransitionRouterOutlet],
  template: `P:<mm-transition-outlet />`,
})
class ParentP {
  constructor() {
    track('p');
  }
}

const routes: Routes = [
  { path: 'a', component: PageA, resolve: { t: createTitle('Page A') } },
  { path: 'b', component: PageB, resolve: { t: createTitle('Page B') } },
  {
    path: 'imm',
    component: PageImm,
    data: { immediateTransition: true },
    resolve: { t: createTitle('Page Imm') },
  },
  { path: 'tab', component: PageTab, resolve: { t: createTitle('Page Tab') } },
  {
    path: 'p',
    component: ParentP,
    children: [{ path: 'c1', component: ChildOne }],
  },
  {
    path: 'pi',
    component: ParentP,
    data: { immediateTransition: true },
    children: [{ path: 'c1', component: ChildOne }],
  },
  { path: 's1', component: SideOne, outlet: 'side' },
  { path: 's2', component: SideTwo, outlet: 'side' },
  { path: 's3', component: SideThree, outlet: 'side' },
  { path: 'blocked', component: PageA, canActivate: [() => false] },
];

@Component({
  selector: 'a11y-contract-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet /><mm-transition-outlet name="side" />`,
})
class Host {}

async function setup(refs: Record<string, FakeRef> = {}) {
  const errors: unknown[] = [];
  const { fixture } = await render(Host, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      provideRouteA11y(),
      { provide: REFS, useValue: refs },
      {
        provide: ErrorHandler,
        useValue: { handleError: (e: unknown) => errors.push(e) },
      },
    ],
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };
  const commit = TestBed.runInInjectionContext(() => injectVisualCommit());
  return { router: TestBed.inject(Router), flush, errors, commit };
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const liveRegion = () => q('[aria-live="polite"]');

describe('provideRouteA11y contract', () => {
  afterEach(() => liveRegion()?.remove());

  it('focuses the view of an immediateTransition route', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/imm');
    await s.flush();
    expect(document.activeElement).toBe(q('page-imm'));
  });

  it('a committed navigation that swaps no view still announces and reports no error', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    const region = liveRegion() as HTMLElement;
    region.textContent = '';

    await s.router.navigateByUrl('/b?x=1');
    await s.flush();
    expect(s.errors).toEqual([]);
    expect(region.textContent).toBe('Page B');
  });

  it('a view root with its own tabindex keeps it, before and after blur', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/tab');
    await s.flush();
    const tab = q('page-tab') as HTMLElement;
    expect(document.activeElement).toBe(tab);
    expect(tab.getAttribute('tabindex')).toBe('0');
    tab.blur();
    expect(tab.getAttribute('tabindex')).toBe('0');
  });

  it('the live region is a whole status message', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/b');
    await s.flush();
    const region = liveRegion() as HTMLElement;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });
});

describe('provideRouteA11y contract: which view takes focus', () => {
  afterEach(() => liveRegion()?.remove());

  it('a late settle of an older hold does not take focus from the navigation that committed', async () => {
    const b = makeRef('loading');
    const s2 = makeRef('loading');
    const s = await setup({ b, s2 });
    await s.router.navigateByUrl('/a(side:s1)');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s1)');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s2)');
    await s.flush();

    b.status.set('resolved');
    await s.flush();
    s2.status.set('resolved');
    await s.flush();
    expect(document.activeElement).toBe(q('side-two'));
  });

  it('focus lands on the parent when a sync parent and its child swap in together', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/p/c1');
    await s.flush();
    expect(document.activeElement).toBe(q('parent-p'));
  });

  it('focus lands on the parent when an immediate parent reports before its child', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/pi/c1');
    await s.flush();
    expect(document.activeElement).toBe(q('parent-p'));
  });

  it('focus lands on the parent when an async parent commits after its child', async () => {
    const p = makeRef('loading');
    const s = await setup({ p });
    await s.router.navigateByUrl('/a');
    await s.flush();
    await s.router.navigateByUrl('/p/c1');
    await s.flush();
    p.status.set('resolved');
    await s.flush();
    expect(document.activeElement).toBe(q('parent-p'));
  });

  it('a root that swapped in for an earlier navigation does not take focus', async () => {
    const b = makeRef('loading');
    const s2 = makeRef('loading');
    const s3 = makeRef('loading');
    const s = await setup({ b, s2, s3 });
    await s.router.navigateByUrl('/a(side:s1)');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s2)');
    await s.flush();
    b.status.set('resolved');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s3)');
    await s.flush();
    s3.status.set('resolved');
    await s.flush();
    expect(s.commit().status).toBe('committed');
    expect(document.activeElement).toBe(q('side-three'));
  });

  it('a cancelled navigation falls back to the newest outstanding hold', async () => {
    const b = makeRef('loading');
    const s2 = makeRef('loading');
    const s = await setup({ b, s2 });
    await s.router.navigateByUrl('/a(side:s1)');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s1)');
    await s.flush();
    await s.router.navigateByUrl('/b(side:s2)');
    await s.flush();
    const newest = s.commit().navigationId;

    await s.router.navigateByUrl('/blocked');
    await s.flush();
    expect(s.commit()).toEqual({ status: 'pending', navigationId: newest });
  });
});
