import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-preloading',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Preloading"
      pkg="@mmstack/router-core"
      lead="Lazy routes keep the initial bundle small, but the chunk only downloads after the click, so the user waits with a blank pane. Preloading closes that gap: fetch the chunk while the user is still deciding, on hover or as the link scrolls into view, so the navigation feels instant."
    >
      <p>
        Angular ships two blunt strategies: preload nothing, or preload
        everything after load. Neither is quite right. Preloading everything
        undoes the point of code-splitting on a large app; preloading nothing
        means every lazy route pays a download on first visit. What you usually
        want is in between: preload the route the user is about to click,
        because their pointer is already on the link. That is what these three
        pieces give you.
      </p>

      <docs-section title="The setup" id="preload-strategy">
        <p>
          <code>PreloadStrategy</code> is the engine. It is a
          <code>PreloadingStrategy</code> that, unlike Angular's built-in ones,
          does nothing until something asks it to preload a specific route. On
          its own it is inert. It listens for requests that
          <code>mmLink</code> and <code>injectTriggerPreload</code> issue, so
          you install it once and drive it from the other two.
        </p>
        <docs-code [code]="strategy" lang="ts" />
        <p>
          It is careful about when it actually fetches. It path-matches the
          requested URL against your route config (route params, matrix params,
          and wildcards all resolve), and it backs off on slow connections
          (<code>effectiveType: '2g'</code>) or when the browser reports
          <code>saveData</code>, evaluated at request time so a connection that
          improves later is not locked out. A route can opt out entirely with
          <code>data: {{ '{' }} preload: false {{ '}' }}</code>, and
          <code>data: {{ '{' }} preloadDelay: 150 {{ '}' }}</code> debounces
          hover intent so a pointer skating across a menu does not fetch every
          chunk it passes. Each path is deduplicated, so it downloads at most
          once.
        </p>
      </docs-section>

      <docs-section title="mmLink" id="mm-link">
        <p>
          <code>Link</code>, used in templates as <code>mmLink</code>, is the
          request source you will use most. It wraps Angular's
          <code>RouterLink</code> and adds the preloading behavior, proxying all
          the standard inputs (<code>queryParams</code>, <code>fragment</code>,
          <code>state</code>, <code>relativeTo</code>) through unchanged. In
          most codebases you can rename <code>routerLink</code> to
          <code>mmLink</code> and be done.
        </p>
        <docs-code [code]="link" lang="ts" />
        <p>
          The two inputs worth learning are <code>preloadOn</code> and
          <code>preload</code>. Think of them as WHEN and WHAT.
        </p>
        <ul>
          <li>
            <code>preloadOn</code> is the WHEN: <code>'hover'</code> (the
            default), <code>'visible'</code> for links that should warm as they
            scroll into view, or <code>null</code> to switch preloading off for
            that link.
          </li>
          <li>
            <code>preload</code> is the WHAT: <code>'all'</code> (the default)
            warms both the lazy chunk and the route's data, while
            <code>'code'</code> warms only the chunk, for links to routes whose
            data is expensive or should not fire speculatively.
          </li>
          <li>
            <code>preloading</code> is an output that fires the moment a route
            is queued, before the JavaScript actually loads, handy for a subtle
            loading affordance.
          </li>
          <li>
            <code>useMouseDown</code> starts navigation on mousedown instead of
            click, which shaves the 50 to 100ms a user spends holding the button
            down. The press's own click is swallowed so navigation still runs
            exactly once, and keyboard activation is unaffected.
          </li>
          <li>
            <code>beforeNavigate</code> runs a hook just before an SPA
            navigation this link kicks off. Modified clicks, middle clicks, and
            <code>target="_blank"</code> are left to the browser and skip it.
          </li>
        </ul>
        <p>
          If you want the same behavior everywhere, set it once with
          <code>provideMMLinkDefaultConfig({{ '{' }} ... {{ '}' }})</code>
          rather than repeating <code>preloadOn</code> and friends on every
          link.
        </p>
      </docs-section>

      <docs-section title="Recipe: warm a heavy route on hover" id="recipe-heavy">
        <p>
          Say your dashboard sits behind a fat chunk, charts, a grid library,
          the works, and first-time visitors feel the download. You do not want
          it in the initial bundle, but you also do not want the click to stall.
          The fix is one input on the link into it.
        </p>
        <docs-code [code]="heavyRecipe" lang="html" />
        <p>
          As soon as the pointer rests on the link, the chunk starts
          downloading. By the time the click lands, it is usually in cache and
          the route mounts immediately. If the connection is slow the strategy
          quietly skips the warm, so you never make a struggling connection
          worse. Combine it with the
          <a mmLink="/docs/router-core/route-data">route-data</a>
          prefetch and the same hover warms the route's <em>data</em> too, not
          just its code.
        </p>
      </docs-section>

      <docs-section title="injectTriggerPreload" id="inject-trigger-preload">
        <p>
          Not every preload hangs off a link. You might want to warm a route
          when a command palette opens, when a keyboard shortcut is armed, or
          from a signal effect watching what the user is hovering elsewhere.
          <code>injectTriggerPreload()</code> hands you a function that runs the
          exact same pipeline as <code>mmLink</code>, so you get all the same
          connection checks and deduplication without a directive.
        </p>
        <docs-code [code]="imperative" lang="ts" />
        <p>
          It needs the same <code>PreloadStrategy</code> installed. Use it as
          the escape hatch; reach for <code>mmLink</code> whenever a link is the
          natural home for the intent.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class PreloadingDoc {
  protected readonly strategy = `import { PreloadStrategy } from '@mmstack/router-core';
import { provideRouter, withPreloading } from '@angular/router';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes, withPreloading(PreloadStrategy))],
};`;

  protected readonly link = `import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';

@Component({
  selector: 'app-navigation',
  imports: [Link],
  template: \`
    <nav>
      <!-- preload on hover (default) -->
      <a [mmLink]="['/features']">Features</a>
      <!-- preload when scrolled into view -->
      <a [mmLink]="['/pricing']" preloadOn="visible">Pricing</a>
      <!-- no preload -->
      <a [mmLink]="['/contact']" [preloadOn]="null">Contact</a>
    </nav>
  \`,
})
export class NavigationComponent {}`;

  protected readonly heavyRecipe = `<!-- the chunk downloads on hover; the click feels instant -->
<a [mmLink]="['/dashboard']" preloadOn="hover">Dashboard</a>

<!-- for a hero CTA below the fold, warm it as it scrolls into view -->
<a [mmLink]="['/reports']" preloadOn="visible">View reports</a>`;

  protected readonly imperative = `import { Component, effect, signal } from '@angular/core';
import { injectTriggerPreload } from '@mmstack/router-core';

@Component({ /* ... */ })
export class CommandPaletteComponent {
  private readonly triggerPreload = injectTriggerPreload();
  protected readonly highlighted = signal<string | null>(null);

  constructor() {
    effect(() => {
      const target = this.highlighted();
      if (target) this.triggerPreload(target); // warm the highlighted result
    });
  }
}`;
}
