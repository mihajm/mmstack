import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { type CreateNavItem } from './nav';
import { type NavConfig, provideNavConfig } from './nav-config';
import { createNavItems } from './nav-resolver';
import { injectNavItems, NavStore } from './nav-store';

@Component({ template: '' })
class DummyComponent {}

function setup(routes: Routes, config?: NavConfig) {
  TestBed.configureTestingModule({
    providers: [provideNavConfig(config), provideRouter(routes)],
  });
  TestBed.inject(NavStore);
  return { router: TestBed.inject(Router) };
}

function items<TMeta = Record<string, unknown>>(name?: string) {
  return TestBed.runInInjectionContext(() => injectNavItems<TMeta>(name));
}

describe('createNavItems / injectNavItems', () => {
  it('registers items and exposes them via injectNavItems()', async () => {
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            { label: 'Home', link: '/home' },
            { label: 'About', link: '/about' },
          ]),
        },
      },
    ]);

    expect(items()().length).toBe(0);

    await router.navigateByUrl('/home');
    TestBed.tick();

    const result = items()();
    expect(result.length).toBe(2);
    expect(result[0].label()).toBe('Home');
    expect(result[1].label()).toBe('About');
  });

  it('returns empty array when no nav is registered for the scope', async () => {
    const { router } = setup([{ path: 'home', component: DummyComponent }]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    expect(items()().length).toBe(0);
  });

  it('accepts a factory returning items', async () => {
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems(() => [{ label: 'Computed', link: '/computed' }]),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    expect(items()()[0].label()).toBe('Computed');
  });

  it('shadows parent registration when a child route registers the same scope', async () => {
    const { router } = setup([
      {
        path: '',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            { label: 'A', link: '/' },
            { label: 'B', link: '/b' },
            { label: 'C', link: '/c' },
          ]),
        },
        children: [
          {
            path: 'c',
            component: DummyComponent,
            resolve: {
              nav: createNavItems([
                { label: 'D', link: '/c/d' },
                { label: 'E', link: '/c/e' },
              ]),
            },
          },
        ],
      },
    ]);

    await router.navigateByUrl('/');
    TestBed.tick();
    expect(items()().map((i) => i.label())).toEqual(['A', 'B', 'C']);

    await router.navigateByUrl('/c');
    TestBed.tick();
    expect(items()().map((i) => i.label())).toEqual(['D', 'E']);

    await router.navigateByUrl('/');
    TestBed.tick();
    expect(items()().map((i) => i.label())).toEqual(['A', 'B', 'C']);
  });

  it('supports named scopes coexisting on the same route', async () => {
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          main: createNavItems([{ label: 'M', link: '/' }], { name: 'main' }),
          side: createNavItems([{ label: 'S', link: '/' }], { name: 'side' }),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    expect(items('main')().map((i) => i.label())).toEqual(['M']);
    expect(items('side')().map((i) => i.label())).toEqual(['S']);
    expect(items()().length).toBe(0);
  });

  it('filters hidden items reactively', async () => {
    const showSecret = signal(false);
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems(() => [
            { label: 'Always', link: '/a' },
            { label: 'Secret', link: '/b', hidden: () => !showSecret() },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    const result = items();
    expect(result().length).toBe(1);
    expect(result()[0].label()).toBe('Always');

    showSecret.set(true);
    expect(result().length).toBe(2);
  });

  it('cascades hidden to descendants and removes the whole subtree from output', async () => {
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems<{ tag: string }>([
            {
              label: 'Parent',
              link: '/parent',
              hidden: true,
              children: [{ label: 'Child', link: '/child' }],
            },
            { label: 'Visible', link: '/visible' },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    const result = items()();
    expect(result.length).toBe(1);
    expect(result[0].label()).toBe('Visible');
  });

  it('cascades disabled to descendants', async () => {
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            {
              label: 'Parent',
              link: '/parent',
              disabled: true,
              children: [{ label: 'Child', link: '/child' }],
            },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    const result = items()();
    expect(result[0].disabled()).toBe(true);
    expect(result[0].children()[0].disabled()).toBe(true);
  });

  it('marks an item active when its link is a subset of the current URL (default)', async () => {
    const { router } = setup([
      {
        path: '**',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            { label: 'Home', link: '/home' },
            { label: 'Products', link: '/products' },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/products/123');
    TestBed.tick();

    const result = items()();
    expect(result[0].active()).toBe(false);
    expect(result[1].active()).toBe(true);
  });

  it('respects per-item activeMatch override (paths: "exact")', async () => {
    const { router } = setup([
      {
        path: '**',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            {
              label: 'Products',
              link: '/products',
              activeMatch: { paths: 'exact' },
            },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/products');
    TestBed.tick();
    expect(items()()[0].active()).toBe(true);

    await router.navigateByUrl('/products/123');
    TestBed.tick();
    expect(items()()[0].active()).toBe(false);
  });

  it('parent without a link is active when any child is active (default)', async () => {
    const { router } = setup([
      {
        path: '**',
        component: DummyComponent,
        resolve: {
          nav: createNavItems<unknown>([
            {
              label: 'Settings',
              children: [
                { label: 'Profile', link: '/settings/profile' },
                { label: 'Security', link: '/settings/security' },
              ],
            } satisfies CreateNavItem<unknown>,
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/settings/security');
    TestBed.tick();

    const parent = items()()[0];
    expect(parent.active()).toBe(true);
    expect(parent.children()[0].active()).toBe(false);
    expect(parent.children()[1].active()).toBe(true);
  });

  it('explicit activeMatch suppresses the child-OR by default', async () => {
    const { router } = setup([
      {
        path: '**',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            {
              label: 'Section',
              link: '/section',
              activeMatch: { paths: 'exact' },
              children: [{ label: 'Sub', link: '/other' }],
            },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/other');
    TestBed.tick();

    const parent = items()()[0];
    expect(parent.children()[0].active()).toBe(true);
    expect(parent.active()).toBe(false);
  });

  it('matchesWhenChildActive: true re-enables child-OR alongside activeMatch', async () => {
    const { router } = setup([
      {
        path: '**',
        component: DummyComponent,
        resolve: {
          nav: createNavItems([
            {
              label: 'Section',
              link: '/section',
              activeMatch: { paths: 'exact' },
              matchesWhenChildActive: true,
              children: [{ label: 'Sub', link: '/other' }],
            },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/other');
    TestBed.tick();

    expect(items()()[0].active()).toBe(true);
  });

  it('round-trips meta with the consumer-side TMeta assertion', async () => {
    type Meta = { icon: string };
    const { router } = setup([
      {
        path: 'home',
        component: DummyComponent,
        resolve: {
          nav: createNavItems<Meta>([
            { label: 'Home', link: '/home', meta: { icon: 'home' } },
          ]),
        },
      },
    ]);

    await router.navigateByUrl('/home');
    TestBed.tick();

    expect(items<Meta>()()[0].meta().icon).toBe('home');
  });

  describe('relative links', () => {
    it('resolves a string link without leading slash relative to the resolver route', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([
              { label: 'A', link: 'a' },
              { label: 'B', link: 'b' },
            ]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      const result = items()();
      expect(result[0].link()).toBe('/myLib/a');
      expect(result[1].link()).toBe('/myLib/b');
    });

    it('resolves an array link relative to the resolver route', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([{ label: 'Nested', link: ['x', 'y'] }]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      expect(items()()[0].link()).toBe('/myLib/x/y');
    });

    it('treats a leading-slash string as an absolute escape hatch', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([{ label: 'Out', link: '/elsewhere' }]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      expect(items()()[0].link()).toBe('/elsewhere');
    });

    it('treats an array whose first segment starts with / as absolute', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([
              { label: 'AbsoluteRoot', link: ['/', 'foo'] },
              { label: 'AbsolutePrefixed', link: ['/fooBar', 'baz'] },
            ]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      const result = items()();
      expect(result[0].link()).toBe('/foo');
      expect(result[1].link()).toBe('/fooBar/baz');
    });

    it('preserves query and fragment when resolving a relative string', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([
              { label: 'WithQuery', link: 'detail?q=1#frag' },
            ]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      expect(items()()[0].link()).toBe('/myLib/detail?q=1#frag');
    });

    it('children inherit the resolver mount as their base', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems<unknown>([
              {
                label: 'Parent',
                link: 'parent',
                children: [{ label: 'Child', link: 'child' }],
              } satisfies CreateNavItem<unknown>,
            ]),
          },
        },
      ]);

      await router.navigateByUrl('/myLib');
      TestBed.tick();

      const parent = items()()[0];
      expect(parent.link()).toBe('/myLib/parent');
      expect(parent.children()[0].link()).toBe('/myLib/child');
    });

    it('active reflects the resolved absolute URL when navigating to it', async () => {
      const { router } = setup([
        {
          path: 'myLib',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([
              { label: 'A', link: 'a' },
              { label: 'B', link: 'b' },
            ]),
          },
          children: [
            { path: 'a', component: DummyComponent },
            { path: 'b', component: DummyComponent },
          ],
        },
      ]);

      await router.navigateByUrl('/myLib/a');
      TestBed.tick();

      const result = items()();
      expect(result[0].link()).toBe('/myLib/a');
      expect(result[0].active()).toBe(true);
      expect(result[1].active()).toBe(false);
    });
  });

  describe('config defaults (fallback nav items)', () => {
    it('renders config defaults when no active route registers items', async () => {
      const { router } = setup(
        [{ path: 'home', component: DummyComponent }],
        {
          defaults: [
            { label: 'Home', link: '/' },
            { label: 'Docs', link: '/docs' },
          ],
        },
      );

      await router.navigateByUrl('/home');
      TestBed.tick();

      const result = items()();
      expect(result.map((i) => i.label())).toEqual(['Home', 'Docs']);
    });

    it('resolves relative links in defaults from the root', async () => {
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: [{ label: 'Home', link: 'home' }],
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      expect(items()()[0].link()).toBe('/home');
    });

    it('a route registering items shadows the defaults', async () => {
      const { router } = setup(
        [
          {
            path: 'home',
            component: DummyComponent,
            resolve: {
              nav: createNavItems([{ label: 'Override', link: '/x' }]),
            },
          },
          { path: 'other', component: DummyComponent },
        ],
        { defaults: [{ label: 'Default', link: '/' }] },
      );

      await router.navigateByUrl('/home');
      TestBed.tick();
      expect(items()().map((i) => i.label())).toEqual(['Override']);

      await router.navigateByUrl('/other');
      TestBed.tick();
      expect(items()().map((i) => i.label())).toEqual(['Default']);
    });

    it('explicit empty createNavItems([]) shadows defaults with an empty menu', async () => {
      const { router } = setup(
        [
          {
            path: 'empty',
            component: DummyComponent,
            resolve: { nav: createNavItems([]) },
          },
          { path: 'other', component: DummyComponent },
        ],
        { defaults: [{ label: 'Default', link: '/' }] },
      );

      await router.navigateByUrl('/empty');
      TestBed.tick();
      expect(items()().length).toBe(0);

      await router.navigateByUrl('/other');
      TestBed.tick();
      expect(items()().map((i) => i.label())).toEqual(['Default']);
    });

    it('accepts a factory form for defaults', async () => {
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: () => [{ label: 'Computed', link: '/' }],
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      expect(items()()[0].label()).toBe('Computed');
    });

    it('supports per-scope defaults via the record form', async () => {
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: {
          main: [{ label: 'M', link: '/' }],
          side: () => [{ label: 'S', link: '/' }],
        },
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      expect(items('main')().map((i) => i.label())).toEqual(['M']);
      expect(items('side')().map((i) => i.label())).toEqual(['S']);
      expect(items()().length).toBe(0);
    });

    it('supports the default scope via the record form using the empty-string key', async () => {
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: {
          '': [{ label: 'Root', link: '/' }],
          side: [{ label: 'S', link: '/' }],
        },
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      expect(items()().map((i) => i.label())).toEqual(['Root']);
      expect(items('side')().map((i) => i.label())).toEqual(['S']);
    });

    it('returns empty for a scope with no config entry and no route registration', async () => {
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: { main: [{ label: 'M', link: '/' }] },
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      expect(items('unknown')().length).toBe(0);
    });

    it('filters hidden default items reactively', async () => {
      const show = signal(false);
      const { router } = setup([{ path: 'home', component: DummyComponent }], {
        defaults: () => [
          { label: 'Always', link: '/' },
          { label: 'Secret', link: '/secret', hidden: () => !show() },
        ],
      });

      await router.navigateByUrl('/home');
      TestBed.tick();

      const result = items();
      expect(result().map((i) => i.label())).toEqual(['Always']);

      show.set(true);
      expect(result().map((i) => i.label())).toEqual(['Always', 'Secret']);
    });

    it('default items reflect active state against the current URL', async () => {
      const { router } = setup(
        [
          { path: 'home', component: DummyComponent },
          { path: 'docs', component: DummyComponent },
        ],
        {
          defaults: [
            { label: 'Home', link: '/home' },
            { label: 'Docs', link: '/docs' },
          ],
        },
      );

      await router.navigateByUrl('/docs');
      TestBed.tick();
      let result = items()();
      expect(result[0].active()).toBe(false);
      expect(result[1].active()).toBe(true);

      await router.navigateByUrl('/home');
      TestBed.tick();
      result = items()();
      expect(result[0].active()).toBe(true);
      expect(result[1].active()).toBe(false);
    });
  });

  it('applies provideNavConfig activeMatch as the global default', async () => {
    const { router } = setup(
      [
        {
          path: '**',
          component: DummyComponent,
          resolve: {
            nav: createNavItems([{ label: 'Products', link: '/products' }]),
          },
        },
      ],
      { activeMatch: { paths: 'exact' } },
    );

    await router.navigateByUrl('/products/123');
    TestBed.tick();
    expect(items()()[0].active()).toBe(false);

    await router.navigateByUrl('/products');
    TestBed.tick();
    expect(items()()[0].active()).toBe(true);
  });
});
