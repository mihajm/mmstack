import { ViewportScroller } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { render } from '@testing-library/angular';
import { TransitionRouterOutlet } from '../transition-router-outlet';
import { provideTransitionScrollRestoration } from './transition-scroll';

@Component({ selector: 'child-one', template: `C1` })
class ChildOne {}

@Component({
  selector: 'toggle-page',
  imports: [TransitionRouterOutlet],
  template: `@if (show()) {
    <mm-transition-outlet />
  }`,
})
class TogglePage {
  static instance: TogglePage | null = null;
  readonly show = signal(true);
  constructor() {
    TogglePage.instance = this;
  }
}

@Component({ selector: 'plain-page', template: `plain` })
class PlainPage {}

const routes: Routes = [
  { path: 'plain', component: PlainPage },
  {
    path: 't',
    component: TogglePage,
    children: [{ path: 'c', component: ChildOne }],
  },
];

@Component({
  selector: 'scroll-contract-host',
  imports: [TransitionRouterOutlet],
  template: `<mm-transition-outlet />`,
})
class Host {}

async function setup() {
  const calls: unknown[] = [];
  const restoration: string[] = [];
  const scroller = {
    getScrollPosition: () => [0, 0],
    scrollToPosition: (v: unknown) => calls.push(v),
    scrollToAnchor: (v: unknown) => calls.push(v),
    setHistoryScrollRestoration: (v: string) => restoration.push(v),
    scrollToElement: () => undefined,
    setOffset: () => undefined,
  } as unknown as ViewportScroller;
  const { fixture } = await render(Host, {
    providers: [
      provideRouter(routes),
      provideLocationMocks(),
      { provide: ViewportScroller, useValue: scroller },
      provideTransitionScrollRestoration(),
    ],
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) {
      fixture.detectChanges();
      await Promise.resolve();
    }
    fixture.detectChanges();
  };
  return { router: TestBed.inject(Router), flush, calls, restoration };
}

describe('provideTransitionScrollRestoration contract', () => {
  it('turns native history scroll restoration off', async () => {
    const s = await setup();
    expect(s.restoration).toEqual(['manual']);
  });

  it('an outlet created after the commit does not scroll the page again', async () => {
    const s = await setup();
    await s.router.navigateByUrl('/plain');
    await s.flush();
    await s.router.navigateByUrl('/t/c');
    await s.flush();
    s.calls.length = 0;

    TogglePage.instance?.show.set(false);
    await s.flush();
    TogglePage.instance?.show.set(true);
    await s.flush();
    expect(document.querySelector('child-one')).not.toBeNull();
    expect(s.calls).toEqual([]);
  });
});
