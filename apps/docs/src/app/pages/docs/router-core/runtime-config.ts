import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-router-core-runtime-config',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Runtime route config"
      pkg="@mmstack/router-core"
      lead="Two primitives for apps whose route config is not fully known at build time: throw a lazy subtree away and load it again, or swap a route's definition wholesale, transactionally."
    >
      <p>
        The use cases are things like a lazy feature whose routes are generated
        from data that changes, a preview of a page the user is editing, or an
        A/B variant. Both primitives are keyed by a <strong>marker id</strong>
        rather than by <code>Route</code> identity, because
        <code>Router.resetConfig</code> shallow-copies every route it
        standardizes: object identity goes stale while the marker survives.
      </p>

      <docs-section title="Remounting a lazy subtree" id="remount">
        <p>
          <code>remountable(id)</code> marks a lazy route;
          <code>injectRemountHandle(id)</code> invalidates it, which throws the
          loaded subtree away and runs <code>loadChildren</code> again.
        </p>
        <docs-code [code]="remountRoute" lang="ts" />
        <docs-code [code]="remountHandle" lang="ts" />
        <ul>
          <li>
            <strong>Invalidation orphans the route object.</strong> The cached
            children, injector, module factory and component are dropped, and
            the <code>Route</code> they were cached on is replaced in the
            config. A load or preload already in flight lands on the discarded
            object, so it can never repopulate the live config.
          </li>
          <li>
            <strong>It re-enters the current URL</strong> with
            <code>onSameUrlNavigation: 'reload'</code>, and
            <code>invalidate()</code> resolves once that navigation is done, so
            awaiting it means the subtree is back. Pass
            <code>navigation: 'none'</code> to drop the cache without
            navigating; the next navigation into the subtree picks up the fresh
            load.
          </li>
          <li>
            <strong>The old subtree's injectors are destroyed</strong> once the
            replacement has loaded and its navigation is visually committed,
            the point at which the old view is gone by construction. Under
            <code>navigation: 'none'</code> that is the eventual next load of
            the marker; the still-mounted view keeps its injector until then,
            stale by design.
          </li>
          <li>
            <strong>Preload memory is cleared</strong> for the invalidated path
            and everything under it, so the subtree can be hover-warmed again
            (the
            <a mmLink="/docs/router-core/preloading">preload strategy</a>
            otherwise warms a path at most once).
          </li>
          <li>
            <strong><code>generation</code></strong> is a counter signal that
            bumps on every invalidation that dropped something. Key derived
            state off it, or use it to tell whether work started under an older
            config is still current.
          </li>
          <li>
            <strong>The outcome says what happened:</strong>
            <code>remounted</code>, <code>no-op</code> (the route had nothing
            cached, so <code>generation</code> does not move and no navigation
            runs), or <code>rejected</code> (below).
          </li>
        </ul>
        <p>
          <code>invalidate()</code> takes an <code>inFlight</code> option for
          what to do when any navigation is already in flight. It is
          deliberately conservative about relevance, since a navigation
          mid-recognition can still turn out to touch the subtree.
          <code>'wait'</code> (the default) runs once the in-flight navigation
          settles, and invalidations that queue up meanwhile coalesce into a
          single run. <code>'cancel-and-retry'</code> aborts the in-flight
          navigation, then runs. <code>'reject'</code> does nothing and
          resolves <code>{{ '{' }} outcome: 'rejected' {{ '}' }}</code>.
        </p>
        <p>
          The handle is shared per id, so every injection sees the same one.
          <code>invalidate()</code> throws if no route in the config carries
          the marker; that is a wiring bug, not a runtime outcome.
        </p>
      </docs-section>

      <docs-section title="Swapping a mount" id="mount-switch">
        <p>
          <code>mountSwitchRoute(id, factory)</code> declares a route whose
          definition can be replaced at runtime;
          <code>injectMountController(id)</code> performs the swap. The factory
          produces the route: once for the initial mount, again for every
          switch.
        </p>
        <docs-code [code]="mountRoute" lang="ts" />
        <docs-code [code]="mountController" lang="ts" />
        <p>
          Swapping is transactional: the new definition goes into the config,
          navigation re-enters (the current URL, or
          <code>switch({{ '{' }} target {{ '}' }})</code>), and the transaction
          settles on the router's own events.
        </p>
        <ul>
          <li>
            <strong><code>committed</code></strong> means the navigation onto
            the new mount reached <code>NavigationEnd</code>.
          </li>
          <li>
            <strong><code>rolled-back</code></strong>, with
            <code>reason: 'cancelled' | 'error'</code>, means the navigation
            hit a <code>NavigationError</code>, or a cancel that is not a
            redirect (a guard rejecting the new definition, say). The previous
            definition goes back into the config with its lazy cache intact, so
            the loader does not re-run, and whatever the abandoned navigation
            staged, its title registration included, is dropped with it.
          </li>
          <li>
            <strong><code>superseded</code></strong> means a newer switch took
            over the config first. The queue is one deep and the newest wins;
            the newer transaction inherits the older one's rollback point, so a
            rollback lands on the mount that was last live rather than on one
            that only ever existed mid-transaction.
          </li>
        </ul>
        <p>
          <code>switch()</code> is for anywhere outside the router's own
          recognition pass: an effect, a click handler. Inside recognition, use
          <code>beginSwitch()</code>. It swaps synchronously and returns the
          <code>UrlTree</code> the navigation should re-enter with, which is
          exactly what a <code>canMatch</code> guard returns to redirect. The
          router's redirect hop then lands on the new mount, and the
          transaction rides it rather than reading it as an abort.
        </p>
        <docs-code [code]="beginSwitch" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class RuntimeConfigDoc {
  protected readonly remountRoute = `import { Routes } from '@angular/router';
import { remountable } from '@mmstack/router-core';

export const appRoutes: Routes = [
  {
    path: 'reports',
    loadChildren: () => import('./reports/routes').then((m) => m.reportRoutes),
    data: { ...remountable('reports') },
  },
];`;

  protected readonly remountHandle = `import { Component } from '@angular/core';
import { injectRemountHandle } from '@mmstack/router-core';

@Component({ /* ... */ })
export class ReportDesigner {
  private readonly reports = injectRemountHandle('reports');

  async onDefinitionChanged() {
    const { outcome } = await this.reports.invalidate();
    if (outcome === 'remounted') this.toast('Reports reloaded');
  }
}`;

  protected readonly mountRoute = `import { mountSwitchRoute } from '@mmstack/router-core';

export const appRoutes: Routes = [
  mountSwitchRoute('preview', () => ({
    path: 'preview',
    children: buildRoutesFromDefinition(currentDefinition()),
  })),
];`;

  protected readonly mountController = `import { injectMountController } from '@mmstack/router-core';

@Component({ /* ... */ })
export class PreviewToolbar {
  private readonly preview = injectMountController('preview');

  // later, when the definition changes:
  async rebuild() {
    const { outcome } = await this.preview.switch();
    if (outcome === 'rolled-back') this.toast('Preview could not be rebuilt');
  }
}`;

  protected readonly beginSwitch = `mountSwitchRoute('preview', () => ({
  path: 'preview',
  canMatch: [
    () => {
      const controller = injectMountController('preview');
      // the redirect hop runs this guard again; the second pass must not swap again
      if (!definitionChanged()) return true;

      void controller.outcome().then((result) => {
        if (result.outcome === 'rolled-back') selected.set(lastCommitted());
      });
      return controller.beginSwitch();
    },
  ],
  children: buildRoutesFromDefinition(currentDefinition()),
}));`;
}
