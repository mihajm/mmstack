import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { injectLeafRoutes } from './leaf.store';

@Component({ template: '' })
class Dummy {}

async function leavesAt(routes: Routes, url: string) {
  TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
  const leaves = TestBed.runInInjectionContext(() => injectLeafRoutes());
  await TestBed.inject(Router).navigateByUrl(url);
  TestBed.tick();
  return leaves().map((l) => l.path);
}

describe('leaf routes contract: primary chain only', () => {
  it('does not walk into a named outlet next to the primary child', async () => {
    const paths = await leavesAt(
      [
        {
          path: 'a',
          component: Dummy,
          children: [{ path: 'b', component: Dummy }],
        },
        { path: 'p', component: Dummy, outlet: 'popup' },
      ],
      '/a/b(popup:p)',
    );
    expect(paths).toEqual(['/', '/a', '/a/b']);
  });

  it('does not walk into a named outlet when there is no primary child', async () => {
    const paths = await leavesAt(
      [
        {
          path: 'a',
          component: Dummy,
          children: [{ path: 'b', component: Dummy, outlet: 'popup' }],
        },
      ],
      '/a/(popup:b)',
    );
    expect(paths).toEqual(['/', '/a']);
  });
});
