import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-visual-commit',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Visual commit"
      pkg="@mmstack/router-core"
      lead="NavigationEnd means the router is finished, not that anything changed on screen. The visual commit is the moment the screen actually shows the new route, and it is where scroll restoration, focus moves, announcements and analytics belong."
    >
      <p>
        Under a
        <a mmLink="/docs/router-core/transition-outlet">held transition</a> the
        incoming view is still hidden when <code>NavigationEnd</code> fires,
        and with several or nested outlets there is no single moment
        <code>NavigationEnd</code> could stand in for. The visual commit is
        that moment: every outlet that armed for the navigation has finished
        its swap, so the user is finally looking at the new route. Anything
        that has to line up with what they see belongs there rather than on a
        router event.
      </p>

      <docs-section title="injectVisualCommit" id="inject-visual-commit">
        <p>
          A read-only signal of
          <code>{{ '{' }} status, navigationId {{ '}' }}</code>.
          <code>navigationId</code> is the router's own
          <code>NavigationStart.id</code>, so it correlates with router events
          if you need to line the two up.
        </p>
        <docs-code [code]="commit" lang="ts" />
        <ul>
          <li>
            <strong><code>pending</code></strong> from
            <code>NavigationStart</code> until every outlet that armed for the
            navigation has committed or swapped in immediately. A navigation no
            outlet armed for commits one render after
            <code>NavigationEnd</code>.
          </li>
          <li>
            <strong><code>committed</code></strong> once the swap is on screen.
          </li>
          <li>
            <strong><code>idle</code></strong> after a cancelled or failed
            navigation that no successor follows and that left no swap
            outstanding.
          </li>
          <li>
            <strong>An interrupting navigation</strong> re-enters
            <code>pending</code> under its own id; outlets whose hold it
            superseded re-arm under it.
          </li>
          <li>
            <strong>A navigation that dies with no successor</strong> while an
            earlier navigation's hold is still on its way to the screen falls
            back to <code>pending</code> under that earlier navigation, and
            commits when it finally swaps. The status tracks outstanding visual
            work, not the router's bookkeeping: a hold that lands for real gets
            a commit even though the navigation that interrupted it never
            arrived.
          </li>
          <li>
            <strong>On the server</strong> nothing paints, so
            <code>NavigationEnd</code> is the commit and outlet arms are
            ignored.
          </li>
        </ul>
        <p>
          Two providers ride this signal. Both are opt-in, both fire once per
          committed navigation, and neither fires for a navigation superseded
          before it reached the screen.
        </p>
      </docs-section>

      <docs-section title="Scroll restoration" id="scroll-restoration">
        <p>
          <code>provideTransitionScrollRestoration()</code> restores scroll on
          the visual commit. Angular's own restoration scrolls when the router
          activates the route, which under a hold is while the
          <em>previous</em> view is still on screen: the old page jumps, and
          the new one arrives already scrolled to the wrong place. This
          restores after the swap, when the content the position refers to
          actually exists.
        </p>
        <docs-code [code]="scroll" lang="ts" />
        <ul>
          <li>Back and forward restore the position that page was left at.</li>
          <li>
            A forward navigation goes to the top, or to the element named by
            the URL fragment.
          </li>
          <li>
            It switches the browser's own restoration to <code>manual</code>,
            since the browser would otherwise restore against the pre-swap DOM.
          </li>
        </ul>
        <p>
          It replaces
          <code>withInMemoryScrolling(&#123; scrollPositionRestoration:
          'enabled' &#125;)</code>. Enable one or the other, not both, or the
          two fight over the same scroll.
        </p>
      </docs-section>

      <docs-section title="Route announcements" id="route-announcements">
        <p>
          <code>provideRouteA11y()</code> makes route changes perceivable to
          assistive technology. A client-side navigation replaces the page
          without any of the signals a document load gives a screen reader:
          focus stays wherever it was, and nothing is announced. On the commit
          it moves focus to the root element of the view that swapped in
          (given a transient <code>tabindex="-1"</code> if it does not already
          have one, and focused with <code>preventScroll</code> so it cannot
          fight scroll restoration), and announces the new document title in a
          polite live region.
        </p>
        <docs-code [code]="a11y" lang="ts" />
        <p>
          The title is read after the hold-aware
          <a mmLink="/docs/router-core/route-ui">title store</a> has applied,
          so what is announced is what the page is actually called. With nested
          outlets the focus target is the outermost view that swapped in; two
          sibling outlets swapping in one navigation have no containment
          relation, so the first to settle is the one focused.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class VisualCommitDoc {
  protected readonly commit = `import { Component, effect, inject } from '@angular/core';
import { injectVisualCommit } from '@mmstack/router-core';

@Component({ selector: 'app-shell' /* ... */ })
export class AppShell {
  private readonly analytics = inject(Analytics);
  private readonly commit = injectVisualCommit();

  constructor() {
    effect(() => {
      // fires when the new route is actually on screen, not at NavigationEnd
      if (this.commit().status === 'committed') this.analytics.pageView();
    });
  }
}`;

  protected readonly scroll = `import { provideRouter } from '@angular/router';
import { provideTransitionScrollRestoration } from '@mmstack/router-core';

bootstrapApplication(App, {
  providers: [provideRouter(routes), provideTransitionScrollRestoration()],
});`;

  protected readonly a11y = `import { provideRouteA11y } from '@mmstack/router-core';

bootstrapApplication(App, {
  providers: [provideRouter(routes), provideRouteA11y()],
});

// both halves default to on; announce only, the app moves focus itself:
provideRouteA11y({ focus: false });`;
}
