import { Component } from '@angular/core';
import {
  DeferredValueDemo,
  LatestDemo,
  TransitionTabsDemo,
} from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-transitions',
  imports: [
    DocPage,
    DocSection,
    CodeExample,
    DemoBox,
    TransitionTabsDemo,
    DeferredValueDemo,
    LatestDemo,
    Link,
  ],
  template: `
    <docs-page
      title="Transitions and suspense"
      pkg="@mmstack/primitives"
      lead="Tools for async UI: hold the current view while the next one loads, keep the last value during a reload, and gate rendering on readiness."
    >
      <docs-section title="The problem" id="problem">
        <p>
          When a value drives an <code>&#64;switch</code> or an
          <code>&#64;if</code>, changing it unmounts the old branch right away.
          If the new branch loads data, the user sees a spinner between the two
          states. Switch tabs three times and you get three flashes.
        </p>
        <p>
          A transition fixes the timing. The old view stays on screen until the
          new one has what it needs, then both swap in a single frame.
        </p>
      </docs-section>

      <docs-section title="Transition scopes" id="scopes">
        <p>
          A scope tracks the resources created under it and reports whether any
          are still loading through a <code>pending</code> signal. Resources
          join the nearest scope when you register them.
          <code>provideTransitionScope()</code> opens a fresh scope at a
          component boundary, and <code>registerResource()</code> adds a
          resource to it.
        </p>
        <docs-code [code]="scopeEx" lang="ts" />
        <p>
          Resources from
          <a mmLink="/docs/resource">&#64;mmstack/resource</a> and Angular's own
          <code>resource()</code> both work. The transition primitives below
          read a scope to know when to swap.
        </p>
      </docs-section>

      <docs-section title="*mmTransition" id="mm-transition">
        <p>
          <code>*mmTransition</code> holds and swaps around any value change.
          The old view keeps its value and stays visible while the new one
          mounts hidden in its own scope. Once that scope settles, they swap.
          The demo runs the same tab panel twice: a plain switch on the left, a
          transition on the right.
        </p>
        <docs-demo title="Flash versus hold">
          @defer (on viewport) {
            <demo-transition-tabs />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="transitionEx" label="template" lang="html" />
        <p>
          The value is required. First render shows immediately since there is
          nothing to hold. Set <code>mmTransitionImmediate</code> to skip
          holding, and <code>mmTransitionViewTransition</code> to animate the
          swap with the View Transitions API where the browser supports it.
        </p>
      </docs-section>

      <docs-section title="mm-suspense" id="suspense">
        <p>
          <code>&lt;mm-suspense&gt;</code> is the readiness gate for a single
          branch. It shows a placeholder until a first value lands, then keeps
          the real content mounted through later reloads and marks it busy
          instead of falling back. Where <code>*mmTransition</code> decides when
          to swap between two views, suspense decides placeholder versus content
          inside one. They compose.
        </p>
        <docs-code [code]="suspenseEx" label="template" lang="html" />
        <p>
          <code>&lt;mm-suspense&gt;</code> provides its own scope, so dropping
          it anywhere just works. Use <code>&lt;mm-unscoped-suspense&gt;</code>
          instead when the resources to coordinate are registered above the
          boundary and you want it to read that outer scope rather than open a
          fresh one.
        </p>
      </docs-section>

      <docs-section title="Imperative transitions" id="start-transition">
        <p>
          <code>injectStartTransition()</code> runs an update as a transition
          from code, for cases where there is no structural directive to hang it
          on.
        </p>
        <docs-code [code]="startEx" lang="ts" />
      </docs-section>

      <docs-section title="Transactions" id="transactions">
        <p>
          A transaction generalizes <code>startTransition</code> to a multi-step
          update you might want to take back.
          <code>injectStartTransaction()</code> returns a
          <code>startTransaction(fn)</code> bound to the nearest scope. It
          freezes the scope's display at the pre-transaction values, then runs
          <code>fn</code>. The writes land on live state right away, so derived
          values and connector requests see them and refetch, but the display
          stays held. On settle it releases the hold and keeps the writes; call
          <code>abort()</code> to roll the writes back and release the hold
          without ever showing the intermediate state.
        </p>
        <docs-code [code]="transactionEx2" lang="ts" />
        <p>
          The returned handle also carries <code>pending</code> and a
          <code>done</code> promise. One caveat: work has to go in flight by the
          first render after the writes to be part of the transaction, so a
          loader behind a debounce or a chained resource is not attributable to
          it. Trigger such work eagerly inside <code>fn</code>. For the plumbing
          under it, <code>createTransaction()</code> is the bare undo log (<code
            >record</code
          >
          / <code>restore</code> / <code>clear</code>) with no scope involved.
        </p>
      </docs-section>

      <docs-section
        title="Morphing elements across a swap"
        id="view-transition-name"
      >
        <p>
          When a held swap runs through the View Transitions API
          (<code>mmTransitionViewTransition</code>, or the transition outlet's
          option), the browser can morph an element from the outgoing view into
          its counterpart in the incoming one instead of cross-fading the whole
          boundary. <code>mmViewTransitionName</code> assigns the pairing name
          per element, so a thumbnail in a list can grow into the hero image on
          the detail view.
        </p>
        <docs-code [code]="viewNameEx" label="template" lang="html" />
        <p>
          The name is normalized to a valid CSS ident, and an empty string or
          <code>'none'</code> clears it. The one rule to keep is that a name
          must be unique among elements visible at capture time, so derive it
          from an id for anything that repeats.
        </p>
      </docs-section>

      <docs-section title="Value-level tools" id="values">
        <p>
          <code>latest</code> builds a derivation over resources with
          <code>use</code>. While a dependency reloads it returns the previous
          result instead of undefined, so downstream reads stay stable. Switch
          users below: the left panel reads the resource directly and blinks to
          empty, the right one holds the last value through the reload.
        </p>
        <docs-demo title="Keep the last value during a reload">
          @defer (on viewport) {
            <demo-latest />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="latestEx" lang="ts" />
        <p>
          Under <code>latest</code> sits <code>keepPrevious</code>, the base
          stale-while-revalidate primitive. It wraps a single signal so it holds
          its last defined value whenever the source goes
          <code>undefined</code>, which is exactly what a resource does
          mid-reload. Reach for it directly when you want to hold one value
          rather than derive over several, and for a structure rather than a
          value there is <code>holdUntilReady(target, ready)</code>: it keeps
          yielding the previous target until the <code>ready()</code> predicate
          flips, so you can mount an incoming subtree off to the side and swap
          only once it has settled. Both are also useful for holding native
          resource snapshots.
        </p>
        <docs-code [code]="keepPreviousEx" lang="ts" />
        <p>
          <code>deferredValue</code> lets a signal lag behind its source so an
          expensive render can be deprioritized, similar in spirit to React's
          <code>useDeferredValue</code>. Type quickly in the filter below: the
          input stays on the live value while the list catches up from the
          deferred one, and <code>deferred.pending()</code> reports the gap. The
          list rows here are deliberately slowed to stand in for an expensive
          render, which is where deferring actually pays off.
        </p>
        <docs-demo title="Deferred filtering">
          @defer (on viewport) {
            <demo-deferred-value />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="deferredEx" lang="ts" />
      </docs-section>

      <docs-section title="On the router" id="router">
        <p>
          The same idea drives navigation in
          <a mmLink="/docs/router-core">&#64;mmstack/router-core</a>:
          <code>mm-transition-outlet</code> holds the current route until the
          next one settles, then swaps.
        </p>
      </docs-section>
    </docs-page>
  `,
  styles: `
    .defer-hint {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin: 0;
    }
  `,
})
export class TransitionsDoc {
  protected readonly scopeEx = `import { resource } from '@angular/core';
import { provideTransitionScope, registerResource } from '@mmstack/primitives';

@Component({
  providers: [provideTransitionScope()], // a fresh scope for this subtree
})
class Panel {
  readonly data = registerResource(
    resource({ params: () => this.id(), loader: ({ params }) => load(params) }),
  );
}`;

  protected readonly transitionEx = `<ng-container *mmTransition="selectedTab(); let tab">
  <app-panel [tab]="tab" />
</ng-container>`;

  protected readonly suspenseEx = `<mm-suspense>
  <app-panel />
  <p placeholder>Loading…</p>
</mm-suspense>`;

  protected readonly startEx = `import { injectStartTransition } from '@mmstack/primitives';

const startTransition = injectStartTransition();

startTransition(() => {
  this.selectedTab.set('activity'); // held and swapped, not flashed
});`;

  protected readonly latestEx = `import { latest, use } from '@mmstack/primitives';

const summary = latest(() => {
  const u = use(userResource); // short-circuits until it has a value
  const o = use(ordersResource);
  return u.name + ': ' + o.length + ' orders';
});`;

  protected readonly transactionEx2 = `import { injectStartTransaction } from '@mmstack/primitives';

const startTransaction = injectStartTransaction();

const txn = startTransaction(() => {
  this.range.set('last-30-days'); // writes live, refetches, display stays held
  this.groupBy.set('week');
});

// later, if the user cancels:
txn.abort(); // roll the writes back, release the hold`;

  protected readonly viewNameEx = `<!-- list view -->
<img [mmViewTransitionName]="'hero-' + item().id" [src]="item().thumb" />

<!-- detail view names the same element, so it morphs across the swap -->
<img [mmViewTransitionName]="'hero-' + item().id" [src]="item().full" />`;

  protected readonly keepPreviousEx = `import { holdUntilReady, keepPrevious } from '@mmstack/primitives';

// hold one value through a reload
const held = keepPrevious(myResource.value);

// hold a structure until the incoming one is ready
const shown = holdUntilReady(selectedId, () => !nextScope.pending());`;

  protected readonly deferredEx = `import { deferredValue } from '@mmstack/primitives';

const query = signal('');
// default 'afterRender' catches up next frame; 'idle' waits for the main
// thread to go idle, so heavy work never blocks the keystroke
const deferred = deferredValue(query, { strategy: 'idle' });

// bind the input to query() so it stays responsive,
// render the expensive list from deferred(),
// and dim it while deferred.pending() is true`;
}
