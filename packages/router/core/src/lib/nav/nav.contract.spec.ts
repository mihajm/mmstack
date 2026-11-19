import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  type Routes,
  withRouterConfig,
} from '@angular/router';
import { type CreateNavItem } from './nav';
import { type NavConfig, provideNavConfig } from './nav-config';
import { createNavItems } from './nav-resolver';
import { injectNavItems, NavStore } from './nav-store';

@Component({ template: '' })
class Dummy {}

function setup(
  items: CreateNavItem[] | (() => CreateNavItem[]),
  config?: NavConfig | (() => NavConfig),
  handling?: 'merge' | 'preserve',
) {
  const routes: Routes = [
    {
      path: 'myLib',
      component: Dummy,
      resolve: { nav: createNavItems(items) },
      children: [{ path: '**', component: Dummy }],
    },
    { path: '**', component: Dummy },
  ];
  TestBed.configureTestingModule({
    providers: [
      provideNavConfig(config as NavConfig),
      handling
        ? provideRouter(
            routes,
            withRouterConfig({ defaultQueryParamsHandling: handling }),
          )
        : provideRouter(routes),
    ],
  });
  TestBed.inject(NavStore);
  return TestBed.inject(Router);
}

const nav = (name?: string) =>
  TestBed.runInInjectionContext(() => injectNavItems(name));

async function at(router: Router, url: string) {
  await router.navigateByUrl(url);
  TestBed.tick();
}

describe('nav contract: relative string links', () => {
  it('keeps matrix params of a relative string', async () => {
    const router = setup([{ label: 'Grid', link: 'a;view=grid' }]);
    await at(router, '/myLib');
    expect(nav()()[0].link()).toBe('/myLib/a;view=grid');
  });

  it('keeps a named-outlet group of a relative string', async () => {
    const router = setup([{ label: 'Panel', link: 'a(side:panel)' }]);
    await at(router, '/myLib');
    expect(nav()()[0].link()).toContain('side:panel');
    expect(nav()()[0].link()).toContain('/myLib');
  });

  it('resolves the mount itself, query-only and empty links', async () => {
    const router = setup([
      { label: 'Overview', link: [] },
      { label: 'Empty', link: '' },
      { label: 'Tab', link: '?tab=x' },
    ]);
    await at(router, '/myLib');
    expect(nav()().map((i) => i.link())).toEqual([
      '/myLib',
      '/myLib',
      '/myLib?tab=x',
    ]);
  });
});

describe('nav contract: defaultQueryParamsHandling applies to every link form', () => {
  const forms: CreateNavItem[] = [
    { label: 'abs string', link: '/a' },
    { label: 'abs array', link: ['/a'] },
    { label: 'rel string', link: 'a' },
    { label: 'rel array', link: ['a'] },
    { label: 'fn', link: () => '/a' },
  ];

  it('merge keeps the current query on every form, and follows it after a navigation', async () => {
    const router = setup(forms, undefined, 'merge');
    await at(router, '/myLib?tab=x');
    const links = () => nav()().map((i) => i.link());
    expect(links()).toEqual([
      '/a?tab=x',
      '/a?tab=x',
      '/myLib/a?tab=x',
      '/myLib/a?tab=x',
      '/a?tab=x',
    ]);
    await at(router, '/myLib?tab=y');
    expect(links()).toEqual([
      '/a?tab=y',
      '/a?tab=y',
      '/myLib/a?tab=y',
      '/myLib/a?tab=y',
      '/a?tab=y',
    ]);
  });

  it('merge lets the link query win over the current one', async () => {
    const router = setup(
      [{ label: 'q', link: 'a?tab=own' }],
      undefined,
      'merge',
    );
    await at(router, '/myLib?tab=x&keep=1');
    expect(nav()()[0].link()).toBe('/myLib/a?tab=own&keep=1');
  });

  it('preserve keeps only the current query', async () => {
    const router = setup(
      [{ label: 'q', link: '/a?tab=own' }],
      undefined,
      'preserve',
    );
    await at(router, '/myLib?tab=x');
    expect(nav()()[0].link()).toBe('/a?tab=x');
  });

  it('without a default no form picks up the current query', async () => {
    const router = setup(forms);
    await at(router, '/myLib?tab=x');
    expect(nav()().map((i) => i.link())).toEqual([
      '/a',
      '/a',
      '/myLib/a',
      '/myLib/a',
      '/a',
    ]);
  });
});

describe('nav contract: item fields', () => {
  it('a plain item is not disabled and has empty meta', async () => {
    const router = setup([{ label: 'A', link: '/a' }]);
    await at(router, '/myLib');
    const [item] = nav()();
    expect(item.disabled()).toBe(false);
    expect(item.meta()).toEqual({});
  });

  it('a function link and a meta factory stay reactive', async () => {
    const target = signal('/a');
    const icon = signal('one');
    const router = setup([
      { label: 'A', link: () => target(), meta: () => ({ icon: icon() }) },
    ]);
    await at(router, '/myLib');
    const [item] = nav()();
    expect(item.link()).toBe('/a');
    expect(item.meta()).toEqual({ icon: 'one' });
    target.set('/b');
    icon.set('two');
    expect(item.link()).toBe('/b');
    expect(item.meta()).toEqual({ icon: 'two' });
  });

  it('a null link is a grouping header: no link, inactive unless a child is', async () => {
    const router = setup([
      {
        label: 'Group',
        link: null,
        children: [{ label: 'C', link: '/elsewhere' }],
      },
    ]);
    await at(router, '/myLib');
    const [group] = nav()();
    expect(group.link()).toBeNull();
    expect(group.active()).toBe(false);
  });

  it('a UrlTree link is passed through unchanged', async () => {
    const tree = signal<unknown>(null);
    const router = setup([{ label: 'T', link: () => tree() as never }]);
    tree.set(router.parseUrl('/x?y=1'));
    await at(router, '/myLib');
    expect(nav()()[0].link()).toBe('/x?y=1');
  });

  it('an explicit id wins, else the serialized link, else distinct fallbacks', async () => {
    const router = setup([
      { id: 'home', label: 'H', link: '/a' },
      { label: 'B', link: '/b' },
      { label: 'G1', children: [{ label: 'x' }, { label: 'y' }] },
      { label: 'G2' },
    ]);
    await at(router, '/myLib');
    const list = nav()();
    expect(list[0].id()).toBe('home');
    expect(list[1].id()).toBe('/b');
    const fallbacks = [
      list[2].id(),
      list[3].id(),
      ...list[2].children().map((c) => c.id()),
    ];
    expect(fallbacks.every((id) => id.length > 0)).toBe(true);
    expect(new Set(fallbacks).size).toBe(fallbacks.length);
  });

  it('children holds only the visible children', async () => {
    const router = setup([
      {
        label: 'P',
        link: '/p',
        children: [
          { label: 'v', link: '/v' },
          { label: 'h', link: '/h', hidden: true },
        ],
      },
    ]);
    await at(router, '/myLib');
    expect(
      nav()()[0]
        .children()
        .map((c) => c.label()),
    ).toEqual(['v']);
  });
});

describe('nav contract: config', () => {
  it('the factory form of provideNavConfig is applied', async () => {
    const router = setup([{ label: 'L', link: '/myLib' }], () => ({
      activeMatch: { paths: 'exact' },
    }));
    await at(router, '/myLib/123');
    expect(nav()()[0].active()).toBe(false);
  });

  it('array defaults fill only the unnamed scope', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideNavConfig({ defaults: [{ label: 'D', link: '/' }] }),
        provideRouter([{ path: '**', component: Dummy }]),
      ],
    });
    TestBed.inject(NavStore);
    await at(TestBed.inject(Router), '/x');
    expect(nav()().map((i) => i.label())).toEqual(['D']);
    expect(nav('main')()).toEqual([]);
  });
});
