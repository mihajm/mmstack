import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-route-ui',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Titles, breadcrumbs and nav"
      pkg="@mmstack/router-core"
      lead="The document title, the breadcrumb trail, and the nav menu all depend on where you are in the route tree. Instead of recomputing them by hand on every navigation, declare them once on the routes and read them reactively from any component."
    >
      <p>
        These three helpers share one shape.
        <code>createTitle</code>, <code>createBreadcrumb</code>, and
        <code>createNavItems</code> attach a small piece of UI intent to a route,
        the page title, its breadcrumb label, the menu it should show. A
        matching reader, <code>injectBreadcrumbs</code> or
        <code>injectNavItems</code> (the title updates the document directly),
        gives a component the live, resolved result as a signal. You declare on
        the route; you read from wherever it makes sense. When the active route
        chain changes, everything recomputes on its own.
      </p>
      <p>
        Nothing here blocks navigation or fetches on its own. A factory can pull
        a label from a store or an i18n service, but the helper's job is to
        collect intent from the route config and expose it reactively, not to
        gate the route. The sidebar of this very docs site is built with
        <code>createNavItems</code>.
      </p>

      <docs-section title="Document title with createTitle" id="title">
        <p>
          <code>createTitle</code> is a resolver for the route's
          <code>title</code> property that sets the document title. Pass it a
          static string for a fixed page, or a factory for a dynamic one. The
          factory receives the route's <code>ActivatedRouteSnapshot</code>, and
          because it runs in an injection context you can inject a store and
          return a signal-driven title that keeps updating as data loads.
        </p>
        <docs-code [code]="title" lang="ts" />
        <p>
          One safety detail: title, breadcrumb, and nav registrations made
          during a navigation are staged. They apply when the navigation commits
          (<code>NavigationEnd</code>) and are dropped if it is cancelled or
          errors, so a guard that rejects a navigation can never leave the wrong
          title in the browser tab.
        </p>
        <p>
          Formatting and fallbacks live in
          <code>provideTitleConfig</code>. Give it a <code>prefix</code> (a
          string, or a full formatter function for total control),
          <code>keepLastKnownTitle</code> (on by default, so a route with no
          title holds the last one instead of blanking), and
          <code>initialTitle</code> for the fallback before any route title is
          active.
        </p>
        <docs-code [code]="titleConfig" lang="ts" />
      </docs-section>

      <docs-section title="Breadcrumbs" id="breadcrumbs">
        <p>
          Breadcrumbs are generated from the route segments by default, so you
          often get a usable trail for free. When you need something better than
          the raw segment, override that route's crumb with
          <code>createBreadcrumb</code>. A component reads the whole trail as a
          signal with <code>injectBreadcrumbs</code> and renders it however it
          likes, the toolkit is headless, it gives you data, not markup.
        </p>
        <docs-code [code]="breadcrumbConsume" lang="ts" />
        <p>
          Each crumb exposes <code>label()</code>, <code>link()</code>, and
          <code>ariaLabel()</code> as signals. One thing to get right:
          <code>crumb.link()</code> is a serialized URL string, so bind it to
          <code>[routerLink]</code> (or <code>[mmLink]</code> if you want
          preloading). Binding it to <code>[href]</code> would trigger a full
          page reload.
        </p>
        <p>
          To override a crumb, register it in the route's <code>resolve</code>
          map. The shorthand form takes a plain label; the factory form runs in
          an injection context and receives the route snapshot, so you can pull
          a dynamic label from a store, which is how a
          <code>/users/:id</code> crumb shows the user's name instead of the id.
          To opt a route out of auto-generation entirely, set
          <code>data: {{ '{' }} skipBreadcrumb: true {{ '}' }}</code>.
        </p>
        <docs-code [code]="breadcrumbDefine" lang="ts" />
        <p>
          Auto-generation itself is configurable through
          <code>provideBreadcrumbConfig</code>. Set
          <code>generation: 'manual'</code> to turn it off (only routes with an
          explicit <code>createBreadcrumb</code> produce a crumb), or pass a
          generator function to control how the default label is derived from
          each leaf route.
        </p>
      </docs-section>

      <docs-section title="Recipe: a breadcrumb trail" id="recipe-breadcrumb">
        <p>
          A working trail is the two halves put together. First, declare crumbs
          on the routes, a static label on the parent and a factory that reads
          the product name on the child.
        </p>
        <docs-code [code]="breadcrumbRoutes" lang="ts" />
        <p>
          Then render the signal in a shared component, once, wherever your
          layout wants the trail.
        </p>
        <docs-code [code]="breadcrumbTemplate" label="template" lang="html" />
        <p>
          Drop that component into your layout once and it stays correct on
          every navigation, including deep param routes, because the trail is a
          signal derived from the active route chain rather than something you
          maintain by hand.
        </p>
      </docs-section>

      <docs-section title="Nav menus" id="nav-menus">
        <p>
          <code>createNavItems</code> declares a menu on a route;
          <code>injectNavItems()</code> reads it back as a
          <code>Signal&lt;NavItem[]&gt;</code>. The useful trick is that the
          menu follows the active route chain: when a deeper route in the chain
          registers items for the same scope, the deeper one wins, and
          navigating away restores the shallower one. So the app shell can show a
          global menu that a section quietly replaces while you are inside it.
        </p>
        <docs-code [code]="navConsume" lang="ts" />
        <p>
          As with breadcrumbs, <code>item.link()</code> is a serialized URL
          string, bind it to <code>[routerLink]</code> or
          <a mmLink="/docs/router-core/preloading"><code>[mmLink]</code></a>,
          not <code>[href]</code>. Items are declared in the route's
          <code>resolve</code> map, and links resolve relative to the route the
          resolver is attached to, exactly like Angular's <code>routerLink</code>
          convention. A leading slash makes a link absolute.
        </p>
        <docs-code [code]="navDefine" lang="ts" />
        <p>
          Relative-by-default is what makes a feature library portable. An nx
          library can export <code>Routes</code> with nav items using relative
          links and not care where the host app mounts it; the links resolve
          against the mount point wherever that turns out to be. The full
          resolution table (arrays, absolute escapes, <code>UrlTree</code>
          passthrough) is in the
          <a href="https://www.npmjs.com/package/@mmstack/router-core" target="_blank" rel="noopener">package README</a>.
        </p>
      </docs-section>

      <docs-section title="Recipe: an active, reactive menu" id="recipe-nav">
        <p>
          The reason to use this over a hand-written menu is the active state
          and the reactivity. <code>NavItem.active</code> is a signal computed
          against the current URL, so a link highlights itself, and
          <code>hidden</code> can be signal-driven, so a menu item appears or
          disappears with a permission without any extra wiring.
        </p>
        <docs-code [code]="navReactive" lang="ts" />
        <p>
          <code>active()</code> uses subset-match defaults (prefix-match paths,
          subset query params, ignore fragment), which is what you want for
          section highlighting; override it per item with
          <code>activeMatch</code> or globally with
          <code>provideNavConfig({{ '{' }} activeMatch {{ '}' }})</code> when you
          need exact matching.
        </p>
        <p>
          Pass <code>{{ '{' }} name {{ '}' }}</code> to
          <code>createNavItems</code> and read with
          <code>injectNavItems('name')</code> to run more than one menu (a top
          bar and a side bar) independently.
        </p>
      </docs-section>

      <docs-section title="Nested children" id="nav-children">
        <p>
          An item can declare <code>children</code> for a nested menu, and each
          child inherits a couple of behaviors from its parent. By default a
          parent counts as active when its own link matches or any descendant is
          active, which is what you want for a grouping header that has no link
          of its own. Setting <code>activeMatch</code> on an item turns that OR
          off; pass <code>matchesWhenChildActive: true</code> to turn it back on.
        </p>
        <p>
          <code>hidden</code> filters an item and its whole subtree out of the
          array, so a permission signal can make a branch appear or vanish.
          <code>disabled</code> keeps the item but cascades down to descendants,
          which is the shape for a permission-gated group you still want to show
          as unavailable rather than hide.
        </p>
        <docs-code [code]="navChildren" lang="ts" />
      </docs-section>

      <docs-section title="Typed metadata" id="nav-meta">
        <p>
          <code>CreateNavItem</code> and <code>NavItem</code> carry a
          <code>TMeta</code> generic, so you can attach an icon, a badge, or
          anything else per item without the library dictating a shape. Declare
          the type once on <code>createNavItems&lt;TMeta&gt;</code>, and read it
          back with <code>injectNavItems&lt;TMeta&gt;()</code>. Registration is
          untyped under the hood, so the reader's generic is a consumer-side
          assertion, and every field including <code>meta</code> comes back as a
          signal.
        </p>
        <docs-code [code]="navMeta" lang="ts" />
      </docs-section>

      <docs-section title="Fallback items" id="nav-defaults">
        <p>
          Routes register their menu on demand, so any URL with no registration
          in its active chain renders an empty menu. To keep a few items visible
          everywhere, declare fallbacks with
          <code>provideNavConfig({{ '{' }} defaults {{ '}' }})</code>, useful for
          landing pages, error routes, or a shell that always shows something.
          Relative links on defaults resolve from <code>/</code>, since there is
          no route to be relative to.
        </p>
        <p>
          The array form fills the default (unnamed) scope. For named scopes,
          pass a record keyed by the <code>name</code> you gave
          <code>createNavItems</code>, where the empty-string key
          <code>''</code> targets the default scope. A scope's entry can be a
          static array or a factory.
        </p>
        <docs-code [code]="navDefaults" lang="ts" />
        <p>
          Defaults are only a fallback. Any active route that calls
          <code>createNavItems</code> shadows them for its scope under the same
          deepest-wins rule as everything else, and a route that registers
          <code>createNavItems([])</code> shadows them with an explicitly empty
          menu.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class RouteUiDoc {
  protected readonly title = `import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { createTitle } from '@mmstack/router-core';

export const routes: Routes = [
  {
    path: 'about',
    title: createTitle('About Us'), // static
    loadComponent: () => import('./about').then((m) => m.About),
  },
  {
    path: 'users/:id',
    title: createTitle((route) => \`User \${route.params['id']}\`), // per-snapshot
    loadComponent: () => import('./user').then((m) => m.User),
  },
  {
    path: 'products/:id',
    // signal-driven, the inner function becomes a computed
    title: createTitle(() => {
      const products = inject(ProductStore);
      return () => \`Product: \${products.product().name ?? 'Loading...'}\`;
    }),
    loadComponent: () => import('./product').then((m) => m.Product),
  },
];`;

  protected readonly titleConfig = `import { provideRouter } from '@angular/router';
import { provideTitleConfig } from '@mmstack/router-core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideTitleConfig({
      prefix: (title) => (title ? \`\${title} · MyApp\` : 'MyApp'),
      initialTitle: 'MyApp',
    }),
  ],
};`;

  protected readonly breadcrumbConsume = `import { Component } from '@angular/core';
import { injectBreadcrumbs } from '@mmstack/router-core';

@Component({ selector: 'app-breadcrumbs' /* template below */ })
export class BreadcrumbsComponent {
  protected readonly breadcrumbs = injectBreadcrumbs();
}`;

  protected readonly breadcrumbDefine = `import { inject } from '@angular/core';
import { createBreadcrumb } from '@mmstack/router-core';

export const routes: Routes = [
  {
    path: 'home',
    component: HomeComponent,
    // shorthand for { label: 'Home' }
    resolve: { breadcrumb: createBreadcrumb('Home') },
  },
  {
    path: 'users/:userId',
    component: UserProfileComponent,
    resolve: {
      breadcrumb: createBreadcrumb((route) => {
        const users = inject(UserStore);
        return {
          label: () =>
            users.user(route.params['userId'])()?.name ?? 'Loading...',
        };
      }),
    },
  },
];`;

  protected readonly breadcrumbRoutes = `import { createBreadcrumb } from '@mmstack/router-core';

export const routes: Routes = [
  {
    path: 'products',
    resolve: { breadcrumb: createBreadcrumb('Products') },
    children: [
      {
        path: ':id',
        resolve: {
          breadcrumb: createBreadcrumb((route) => {
            const products = inject(ProductStore);
            return { label: () => products.byId(route.params['id'])()?.name ?? '…' };
          }),
        },
        component: ProductDetail,
      },
    ],
  },
];`;

  protected readonly breadcrumbTemplate = `<nav aria-label="breadcrumb">
  <ol>
    @for (crumb of breadcrumbs(); track crumb.id) {
      <li>
        <a [routerLink]="crumb.link()" [attr.aria-label]="crumb.ariaLabel()">
          {{ crumb.label() }}
        </a>
      </li>
    }
  </ol>
</nav>`;

  protected readonly navConsume = `import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { injectNavItems } from '@mmstack/router-core';

@Component({
  selector: 'app-top-bar',
  imports: [RouterLink],
  template: \`
    <nav>
      @for (item of items(); track item.id()) {
        <a [routerLink]="item.link()" [class.active]="item.active()">
          {{ item.label() }}
        </a>
      }
    </nav>
  \`,
})
export class TopBar {
  protected readonly items = injectNavItems();
}`;

  protected readonly navDefine = `import { createNavItems } from '@mmstack/router-core';

export const routes: Routes = [
  {
    path: '',
    resolve: {
      // root menu, shown everywhere unless a deeper route overrides it
      nav: createNavItems([
        { label: 'Home', link: '/' },
        { label: 'Products', link: '/products' },
        { label: 'About', link: '/about' },
      ]),
    },
    children: [
      {
        path: 'products',
        loadComponent: () => import('./products').then((m) => m.Products),
        resolve: {
          // inside /products this shadows the root menu; relative links resolve here
          nav: createNavItems([
            { label: 'All', link: '/products' },
            { label: 'Featured', link: 'featured' }, // → /products/featured
            { label: 'Categories', link: 'categories' }, // → /products/categories
          ]),
        },
      },
    ],
  },
];`;

  protected readonly navReactive = `createNavItems(() => [
  { label: 'Home', link: '/' },
  {
    label: 'Admin',
    link: 'admin',
    hidden: () => !permissions.isAdmin(), // signal-driven visibility
    children: [
      { label: 'Users', link: 'admin/users' },
      { label: 'Settings', link: 'admin/settings' },
    ],
  },
]);`;

  protected readonly navChildren = `createNavItems(() => [
  {
    label: 'Reports', // grouping header, no own link
    children: [
      { label: 'Sales', link: 'reports/sales' },
      { label: 'Traffic', link: 'reports/traffic' },
    ],
  },
  {
    label: 'Admin',
    link: 'admin',
    disabled: () => !permissions.isAdmin(), // cascades to children
    children: [
      { label: 'Users', link: 'admin/users' },
      { label: 'Settings', link: 'admin/settings' },
    ],
  },
]);`;

  protected readonly navMeta = `import { createNavItems, injectNavItems } from '@mmstack/router-core';

type NavMeta = { icon: string; badge?: number };

// on the route
createNavItems<NavMeta>([
  { label: 'Inbox', link: 'inbox', meta: { icon: 'mail', badge: 3 } },
]);

// in the component
readonly items = injectNavItems<NavMeta>();
// items()[0].meta().icon → 'mail'`;

  protected readonly navDefaults = `import { provideNavConfig } from '@mmstack/router-core';

// default scope, shown wherever no route registered a menu
provideNavConfig({
  defaults: [
    { label: 'Home', link: '/' },
    { label: 'Docs', link: '/docs' },
  ],
});

// named scopes via the record form; '' targets the default scope
provideNavConfig({
  defaults: {
    '': [{ label: 'Home', link: '/' }],
    main: [{ label: 'Home', link: '/' }], // injectNavItems('main')
    side: () => [{ label: 'Settings', link: '/settings' }], // factory
  },
});`;
}
