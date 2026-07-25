/* eslint-disable @angular-eslint/component-selector */
import { httpResource, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { registerResource } from '@mmstack/primitives';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from './transition-router-outlet';
import { injectVisualCommit, type VisualCommitState } from './visual-commit';

function suspending(url: string) {
  const res = httpResource<string>(() => url);
  registerResource(res, { suspends: true });
  return res;
}

@Component({ selector: 'page-a', template: `A:{{ data.value() ?? '...' }}` })
class PageA {
  readonly data = suspending('/api/a');
}

@Component({ selector: 'page-b', template: `B:{{ data.value() ?? '...' }}` })
class PageB {
  readonly data = suspending('/api/b');
}

@Component({ selector: 'page-c', template: `C:{{ data.value() ?? '...' }}` })
class PageC {
  readonly data = suspending('/api/c');
}

@Component({ selector: 'side-one', template: `S1:{{ data.value() ?? '...' }}` })
class SideOne {
  readonly data = suspending('/api/s1');
}

@Component({ selector: 'side-two', template: `S2:{{ data.value() ?? '...' }}` })
class SideTwo {
  readonly data = suspending('/api/s2');
}

@Component({ selector: 'plain-x', template: `X` })
class PlainX {}

@Component({
  selector: 'commit-host',
  imports: [TransitionRouterOutlet],
  template: `
    <mm-transition-outlet (swapCommit)="primary.push($event.outcome)" />
    <mm-transition-outlet
      name="side"
      (swapCommit)="side.push($event.outcome)"
    />
  `,
})
class CommitHost {
  readonly primary: string[] = [];
  readonly side: string[] = [];
}

@Component({
  selector: 'no-outlet-host',
  template: `nothing here`,
})
class NoOutletHost {}

const routes: Routes = [
  { path: 'a', component: PageA },
  { path: 'b', component: PageB },
  { path: 'c', component: PageC },
  { path: 'x', component: PlainX },
  { path: 'imm', component: PageB, data: { immediateTransition: true } },
  { path: 's1', component: SideOne, outlet: 'side' },
  { path: 's2', component: SideTwo, outlet: 'side' },
  { path: 'blocked', component: PlainX, canActivate: [() => false] },
];

async function setup<T>(host: new () => T) {
  const rendered = await render(host, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const commit = TestBed.runInInjectionContext(
    () => injectVisualCommit() as Signal<VisualCommitState>,
  );
  return {
    ...rendered,
    router: TestBed.inject(Router),
    http: TestBed.inject(HttpTestingController),
    commit,
  };
}

const flush = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 8; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
};

describe('swapCommit taxonomy', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('`immediate` — an activation with no previous view, reported after it renders', async () => {
    const { fixture, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    expect(host.primary).toEqual(['immediate']);

    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    expect(host.primary).toEqual(['immediate']);
  });

  it('`committed` — a held view swapped out once the incoming route settles', async () => {
    const { fixture, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    host.primary.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    expect(host.primary).toEqual([]);

    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(host.primary).toEqual(['committed']);
  });

  it('`committed` fires only after the DOM actually flipped', async () => {
    const { fixture, container, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;
    const seen: (string | null)[] = [];

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    host.primary.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    seen.push(
      (container.querySelector('page-b') as HTMLElement | null)?.style
        .display ?? null,
    );
    expect(seen).toEqual(['none']);
    expect(host.primary).toEqual([]);

    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(host.primary).toEqual(['committed']);
    expect(
      (container.querySelector('page-b') as HTMLElement | null)?.style.display,
    ).toBe('');
    expect(container.querySelector('page-a')).toBeNull();
  });

  it('`superseded` — an armed hold re-targeted by an interrupting navigation, once', async () => {
    const { fixture, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    host.primary.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');

    await router.navigateByUrl('/c');
    await flush(fixture);
    expect(host.primary).toEqual(['superseded']);

    http.expectOne('/api/c').flush('CC');
    await flush(fixture);
    expect(host.primary).toEqual(['superseded', 'committed']);
  });

  it('`superseded` then `immediate` when the interrupting route opts out of holding', async () => {
    const { fixture, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    host.primary.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');

    await router.navigateByUrl('/imm');
    await flush(fixture);
    expect(host.primary).toEqual(['superseded', 'immediate']);
    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
  });

  it('`outlet-destroyed` — the outlet goes away while still holding', async () => {
    const { fixture, router, http } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    host.primary.length = 0;

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');

    fixture.destroy();
    expect(host.primary).toEqual(['outlet-destroyed']);
  });
});

describe('visual commit coordinator', () => {
  afterEach(() =>
    TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }),
  );

  it('is idle before anything navigates', async () => {
    const { commit } = await setup(CommitHost);
    expect(commit()).toEqual({ status: 'idle', navigationId: null });
  });

  it('pends from NavigationStart and commits when the outlet swaps', async () => {
    const { fixture, router, http, commit } = await setup(CommitHost);

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    expect(commit().status).toBe('committed');
    const firstId = commit().navigationId;

    const nav = router.navigateByUrl('/b');
    await flush(fixture);
    expect(commit().status).toBe('pending');
    expect(commit().navigationId).not.toBe(firstId);

    await nav;
    await flush(fixture);
    expect(commit().status).toBe('pending'); // NavigationEnd is not the visual commit

    http.expectOne('/api/b').flush('BB');
    await flush(fixture);
    expect(commit().status).toBe('committed');
  });

  it('a navigation with no outlet at all commits one render after NavigationEnd', async () => {
    const { fixture, router, commit } = await setup(NoOutletHost);

    await router.navigateByUrl('/x');
    expect(commit().status).toBe('pending');

    await flush(fixture);
    expect(commit()).toEqual({
      status: 'committed',
      navigationId: expect.any(Number),
    });
  });

  it('waits for every armed outlet, in whatever order they settle', async () => {
    const { fixture, router, http, commit } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a(side:s1)');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    http.expectOne('/api/s1').flush('SS1');
    await flush(fixture);
    expect(commit().status).toBe('committed');
    host.primary.length = 0;
    host.side.length = 0;

    await router.navigateByUrl('/b(side:s2)');
    await flush(fixture);
    const primaryReq = http.expectOne('/api/b');
    const sideReq = http.expectOne('/api/s2');
    expect(commit().status).toBe('pending');

    // The named outlet settles first — the coordinator must still wait for the primary one.
    sideReq.flush('SS2');
    await flush(fixture);
    expect(host.side).toEqual(['committed']);
    expect(host.primary).toEqual([]);
    expect(commit().status).toBe('pending');

    primaryReq.flush('BB');
    await flush(fixture);
    expect(host.primary).toEqual(['committed']);
    expect(commit().status).toBe('committed');
  });

  it('an interrupting navigation re-enters pending under the new id and the outlet re-arms', async () => {
    const { fixture, router, http, commit } = await setup(CommitHost);

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);

    await router.navigateByUrl('/b');
    await flush(fixture);
    http.expectOne('/api/b');
    const interruptedId = commit().navigationId;
    expect(commit().status).toBe('pending');

    await router.navigateByUrl('/c');
    await flush(fixture);
    expect(commit().status).toBe('pending');
    expect(commit().navigationId).not.toBe(interruptedId);

    http.expectOne('/api/c').flush('CC');
    await flush(fixture);
    expect(commit().status).toBe('committed');
  });

  it('a failed navigation returns to idle', async () => {
    const failing: Routes = [
      { path: 'a', component: PlainX },
      {
        path: 'boom',
        component: PlainX,
        resolve: {
          boom: () => {
            throw new Error('resolver exploded');
          },
        },
      },
    ];
    const rendered = await render(CommitHost, {
      providers: [
        provideRouter(failing),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const router = TestBed.inject(Router);
    const commit = TestBed.runInInjectionContext(() => injectVisualCommit());

    await router.navigateByUrl('/a');
    await flush(rendered.fixture);
    expect(commit().status).toBe('committed');

    await router.navigateByUrl('/boom').catch(() => undefined);
    await flush(rendered.fixture);

    expect(commit()).toEqual({ status: 'idle', navigationId: null });
  });

  it('a cancelled navigation falls back to the hold it never took over', async () => {
    const { fixture, router, http, commit } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    await flush(fixture);
    host.primary.length = 0;

    // /b activates and holds, waiting on its resource.
    await router.navigateByUrl('/b');
    await flush(fixture);
    const heldId = commit().navigationId;
    const held = http.expectOne('/api/b');
    expect(commit().status).toBe('pending');

    // A guard rejects /blocked before it activates, so /b's hold is untouched and still live.
    expect(await router.navigateByUrl('/blocked')).toBe(false);
    await flush(fixture);
    expect(commit()).toEqual({ status: 'pending', navigationId: heldId });
    expect(host.primary).toEqual([]);

    // It then swaps for real — a screen change the coordinator has to account for.
    held.flush('BB');
    await flush(fixture);
    expect(host.primary).toEqual(['committed']);
    expect(commit()).toEqual({ status: 'committed', navigationId: heldId });

    // And the next navigation is tracked normally again.
    await router.navigateByUrl('/c');
    await flush(fixture);
    expect(commit().status).toBe('pending');
    http.expectOne('/api/c').flush('CC');
    await flush(fixture);
    expect(commit().status).toBe('committed');
    expect(commit().navigationId).not.toBe(heldId);
  });

  it('a hold that lands after a newer navigation committed does not move the status back', async () => {
    const { fixture, router, http, commit } = await setup(CommitHost);
    const host = fixture.componentInstance;

    await router.navigateByUrl('/a(side:s1)');
    await flush(fixture);
    http.expectOne('/api/a').flush('AA');
    http.expectOne('/api/s1').flush('SS1');
    await flush(fixture);
    host.primary.length = 0;
    host.side.length = 0;

    // The primary outlet holds; the named one is reused, so this navigation cannot commit.
    await router.navigateByUrl('/b(side:s1)');
    await flush(fixture);
    const primaryReq = http.expectOne('/api/b');
    const heldId = commit().navigationId;

    // A navigation that only re-targets the named outlet — the primary hold is untouched.
    await router.navigateByUrl('/b(side:s2)');
    await flush(fixture);
    http.expectOne('/api/s2').flush('SS2');
    await flush(fixture);
    const sideId = commit().navigationId;
    expect(commit().status).toBe('committed');
    expect(sideId).not.toBe(heldId);
    expect(host.primary).toEqual([]);

    // The older hold finally swaps. It is a real swap for that outlet, but the navigation-level
    // status has moved on and must not walk backwards.
    primaryReq.flush('BB');
    await flush(fixture);
    expect(host.primary).toEqual(['committed']);
    expect(commit()).toEqual({ status: 'committed', navigationId: sideId });
  });

  it('a cancelled navigation with nothing outstanding returns to idle', async () => {
    const rejecting: Routes = [
      { path: 'a', component: PlainX },
      { path: 'blocked', component: PlainX, canActivate: [() => false] },
    ];
    const rendered = await render(CommitHost, {
      providers: [
        provideRouter(rejecting),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const router = TestBed.inject(Router);
    const commit = TestBed.runInInjectionContext(() => injectVisualCommit());

    await router.navigateByUrl('/a');
    await flush(rendered.fixture);
    expect(commit().status).toBe('committed');

    await router.navigateByUrl('/blocked');
    await flush(rendered.fixture);
    expect(commit()).toEqual({ status: 'idle', navigationId: null });
  });
});
