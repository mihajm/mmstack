import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { createTitle } from '../title/title-store';
import {
  type BreadcrumbConfig,
  provideBreadcrumbConfig,
} from './breadcrumb-config';
import { createBreadcrumb } from './breadcrumb-resolver';
import { BreadcrumbStore, injectBreadcrumbs } from './breadcrumb-store';

@Component({ template: '' })
class Dummy {}

function setup(routes: Routes, config?: BreadcrumbConfig) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      ...(config ? [provideBreadcrumbConfig(config)] : []),
    ],
  });
  TestBed.inject(BreadcrumbStore);
  const crumbs = TestBed.runInInjectionContext(() => injectBreadcrumbs());
  const router = TestBed.inject(Router);
  const go = async (url: string) => {
    const ok = await router.navigateByUrl(url);
    TestBed.tick();
    return ok;
  };
  return {
    go,
    labels: () => crumbs().map((c) => c.label()),
    crumbs,
  };
}

describe('breadcrumb contract: labels', () => {
  it('uses a custom generation function', async () => {
    const s = setup([{ path: 'home', component: Dummy }], {
      generation: () => (leaf) => 'X ' + leaf.segment.path,
    });
    await s.go('/home');
    expect(s.labels()).toEqual(['X home']);
  });

  it('falls back to data.title, also when the config title is a resolver', async () => {
    const s = setup([
      { path: 'plain', component: Dummy, data: { title: 'From Data' } },
      {
        path: 'resolved',
        component: Dummy,
        title: createTitle('Resolved'),
        data: { title: 'Crumb' },
      },
    ]);
    await s.go('/plain');
    expect(s.labels()).toEqual(['From Data']);
    await s.go('/resolved');
    expect(s.labels()).toEqual(['Crumb']);
  });

  it('an auto crumb for a param segment shows the resolved value', async () => {
    const s = setup([{ path: 'users/:id', component: Dummy }]);
    await s.go('/users/123');
    expect(s.labels().at(-1)).toBe('123');
  });

  it('a slot reused across navigations takes the new id', async () => {
    const s = setup([
      { path: 'home', component: Dummy },
      { path: 'settings-page', component: Dummy },
    ]);
    await s.go('/home');
    expect(s.crumbs()[0].id).toBe('/home');
    await s.go('/settings-page');
    expect(s.crumbs()[0].id).toBe('/settings-page');
  });

  it('a registered crumb links to its route', async () => {
    const s = setup([
      {
        path: 'home',
        component: Dummy,
        children: [
          {
            path: 'child',
            component: Dummy,
            resolve: { b: createBreadcrumb('Child') },
          },
        ],
      },
    ]);
    await s.go('/home/child');
    expect(s.crumbs().map((c) => c.link())).toEqual(['/home', '/home/child']);
  });

  it('a custom generation sees the latest data of a route that keeps its link', async () => {
    let n = 0;
    const s = setup(
      [
        {
          path: 'items',
          component: Dummy,
          runGuardsAndResolvers: 'always',
          resolve: { d: () => ++n },
        },
      ],
      { generation: () => (leaf) => `D${leaf.route.data['d']}` },
    );
    await s.go('/items?x=1');
    expect(s.labels()).toEqual(['D1']);
    await s.go('/items?x=2');
    expect(s.labels()).toEqual(['D2']);
  });
});

describe('breadcrumb contract: skipBreadcrumb', () => {
  it('skips auto-generation only: a crumb registered on the route still shows', async () => {
    const s = setup([
      {
        path: 'admin',
        component: Dummy,
        data: { skipBreadcrumb: true },
        children: [
          {
            path: 'x',
            component: Dummy,
            data: { skipBreadcrumb: true },
            resolve: { b: createBreadcrumb('X') },
          },
        ],
      },
    ]);
    await s.go('/admin/x');
    expect(s.labels()).toEqual(['X']);
  });
});

describe('breadcrumb contract: awaitValue', () => {
  it('an empty label without awaitValue does not block navigation', async () => {
    const s = setup([
      {
        path: 'home',
        component: Dummy,
        resolve: { b: createBreadcrumb(() => ({ label: signal('') })) },
      },
    ]);
    expect(await s.go('/home')).toBe(true);
  });
});
