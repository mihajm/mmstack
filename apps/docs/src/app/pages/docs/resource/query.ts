import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-query',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="queryResource"
      pkg="@mmstack/resource"
      lead="The read. Give it a function that returns a request, and it fetches, tracks loading and errors, and refetches when the request changes. Layer on caching, retries, and refresh only where you need them."
    >
      <p>
        A query is for data you display: a list, a profile, a search result.
        You describe the request as a function of your signals, and the query
        keeps the result in sync. Change the id, get the new record. It runs on
        its own the first time and re-runs whenever the request comes out
        different, so you never call a fetch method by hand.
      </p>
      <p>
        With no options it is <code>httpResource</code> with a friendlier
        return shape. Everything past that (cache, retry, refresh, circuit
        breaker) is a flag you add per call.
      </p>

      <docs-section title="A first query" id="first">
        <p>
          Return a string for the common case, or a full request object when
          you need params, a method, or headers. Because the function reads
          <code>this.id()</code>, the query refetches every time that signal
          changes.
        </p>
        <docs-code [code]="request" lang="ts" />
        <p>
          The result is a ref of signals. Read them straight in a template and
          it re-renders as the fetch moves through loading, resolved, and
          error.
        </p>
        <docs-code [code]="reading" lang="html" />
        <p>
          <code>value()</code> is the current data, <code>status()</code>
          reports where the fetch is (<code>'loading'</code>,
          <code>'resolved'</code>, <code>'reloading'</code>,
          <code>'error'</code>, and more), and <code>error()</code> holds the
          last error. <code>isLoading()</code> and <code>hasValue()</code> are
          convenience derivations, and <code>reload()</code> forces a refetch
          past the cache.
        </p>
      </docs-section>

      <docs-section title="Enabling and disabling" id="disabling">
        <p>
          A query often depends on something that isn't ready yet: an id that
          hasn't loaded, a filter the user hasn't touched. Return
          <code>undefined</code> from the request function and the resource
          goes quiet. It runs again the moment the function returns a real
          request. No fetch fires while it's disabled.
        </p>
        <docs-code [code]="disabled" lang="ts" />
        <p>
          To know why a resource is idle, read <code>disabledReason()</code>.
          It is <code>'no-request'</code> when the function returned
          <code>undefined</code>, <code>'offline'</code> when the network is
          down, or <code>'circuit-open'</code> when a
          <a mmLink="/docs/resource/caching">circuit breaker</a> tripped, and
          <code>null</code> when the resource is enabled. Branch your UI on that
          rather than inspecting the combined status: an offline banner over a
          held list reads differently from a "service is down" message.
        </p>
        <docs-code [code]="disabledReason" lang="html" />
      </docs-section>

      <docs-section title="Fire on demand" id="manual">
        <p>
          Sometimes a query shouldn't run when the component mounts. A search
          should wait for a submit; a "load report" button should wait for the
          click. That is <code>manualQueryResource</code>. Same request
          function, same options, same ref of signals, but it stays idle until
          you call <code>.trigger()</code>.
        </p>
        <docs-code [code]="manual" lang="ts" />
        <p>
          <code>.trigger()</code> re-evaluates the request function and fetches
          with whatever the signals hold at that moment. Everything else
          (<code>value</code>, <code>status</code>, retry, cache) behaves
          exactly like <code>queryResource</code>. Reach for it whenever "on
          construction" is the wrong time to fetch.
        </p>
      </docs-section>

      <docs-section title="Options" id="options">
        <p>
          Each option is independent, so a call carries only the ones it uses.
          Here is a query that keeps its previous value across reloads, polls,
          refreshes on tab focus, and retries on failure.
        </p>
        <docs-code [code]="options" lang="ts" />
        <table class="doc-table">
          <thead>
            <tr>
              <th>Option</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>defaultValue</code></td>
              <td>
                Initial value before the first request resolves. With it set,
                <code>value()</code> is <code>T</code> rather than
                <code>T | undefined</code>, so you skip the undefined check in
                templates.
              </td>
            </tr>
            <tr>
              <td><code>keepPrevious</code></td>
              <td>
                Hold the previous value, status, and headers while a refresh is
                in flight, so a reload doesn't flash empty.
              </td>
            </tr>
            <tr>
              <td><code>refresh</code></td>
              <td>
                A number polls every n ms. The object form adds
                <code>onFocus</code> (refetch when the tab becomes visible) and
                <code>onReconnect</code> (when the browser comes back online).
              </td>
            </tr>
            <tr>
              <td><code>retry</code></td>
              <td>
                Retry N times on failure with exponential backoff (default
                1000ms times 2 to the power of the attempt).
              </td>
            </tr>
            <tr>
              <td><code>cache</code></td>
              <td>
                Opt this resource into the shared cache. See
                <a mmLink="/docs/resource/caching">caching</a>.
              </td>
            </tr>
            <tr>
              <td><code>circuitBreaker</code></td>
              <td>
                Stop hitting a failing endpoint after a threshold. See
                <a mmLink="/docs/resource/caching">circuit breakers</a>.
              </td>
            </tr>
            <tr>
              <td><code>onError</code></td>
              <td>
                Called on every failed attempt with
                <code>(err, retryCount, isFinal)</code>.
              </td>
            </tr>
            <tr>
              <td><code>register</code></td>
              <td>
                Join the nearest transition scope. See
                <a mmLink="/docs/primitives/transitions">transitions</a>.
              </td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="onError fires on every attempt" id="on-error">
        <p>
          This one trips people up, so it's worth calling out. With
          <code>retry</code> set, <code>onError</code> runs on each failed
          attempt, not only the last. If you toast the user there, they get one
          toast per retry. The <code>isFinal</code> flag separates the two
          concerns: log every attempt, but only tell the user once the retries
          are spent.
        </p>
        <docs-code [code]="onError" lang="ts" />
        <p>
          <code>retryCount</code> is how many retries have already happened
          (<code>0</code> on the first failure). <code>isFinal</code> is
          <code>true</code> when no further retry is scheduled, which is also
          the case when <code>retry</code> is <code>0</code>.
        </p>
      </docs-section>

      <docs-section title="Warming the cache" id="prefetch">
        <p>
          <code>prefetch()</code> fetches into the cache without subscribing,
          so the data is already there when the user navigates. Wire it to a
          hover and the click feels instant. It skips itself on slow
          connections (<code>saveData</code>, 2g), so there is no need to guard
          it.
        </p>
        <docs-code [code]="prefetch" lang="ts" />
      </docs-section>

      <docs-section title="Writing without persisting" id="set-local">
        <p>
          <code>value.set()</code> writes through to the cache, so a persisted
          entry hits IndexedDB and a synced one broadcasts to other tabs. That
          round-trip is fine for plain data but lossy for anything a
          structured clone can't carry: a class instance from a custom
          <code>parse</code> comes back as a bare object on the other side.
          When your parsed value can't survive that, write it with
          <code>setLocal()</code> instead. It updates this tab's memory only,
          skipping both persist and cross-tab sync, and a reload or another tab
          re-fetches to get its own.
        </p>
        <docs-code [code]="setLocal" lang="ts" />
      </docs-section>

      <docs-section title="Escape hatches" id="escape-hatches">
        <p>
          Two per-call knobs step around the defaults when a request is special.
        </p>
        <p>
          The dedupe interceptor coalesces identical in-flight requests so three
          components asking for one URL share a round-trip. To opt a single
          request out (a probe that must genuinely hit the wire each time),
          attach <code>noDedupe()</code> to its
          <a mmLink="/docs/resource/caching">context</a>.
        </p>
        <docs-code [code]="noDedupe" lang="ts" />
        <p>
          A query re-runs when its request function returns something new; an
          identical request is skipped, which is how a double-click on the same
          input coalesces into one fetch. Set
          <code>triggerOnSameRequest: true</code> to fire on every evaluation
          even when the request object is unchanged. Use it sparingly, since it
          gives up that built-in coalescing.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class QueryResourceDoc {
  protected readonly request = `import { queryResource } from '@mmstack/resource';

// string shorthand for { url }
readonly user = queryResource<User>(() => \`/api/users/\${this.id()}\`);

// full request; refetches whenever this.query() changes
readonly results = queryResource<Result[]>(() => ({
  url: '/api/search',
  params: { q: this.query() },
}));`;

  protected readonly reading = `@if (user.isLoading()) {
  <p>Loading…</p>
} @else if (user.error(); as err) {
  <p>Could not load: {{ '{' }}{{ '{' }} err {{ '}' }}{{ '}' }}</p>
} @else {
  <p>{{ '{' }}{{ '{' }} user.value()?.name {{ '}' }}{{ '}' }}</p>
}
<button (click)="user.reload()">Refresh</button>`;

  protected readonly disabled = `readonly post = queryResource<Post>(() => {
  const id = this.selectedId();
  return id ? \`/api/posts/\${id}\` : undefined; // idle until an id is picked
});`;

  protected readonly manual = `import { manualQueryResource } from '@mmstack/resource';

readonly search = manualQueryResource<SearchResult[]>(() => ({
  url: '/api/search',
  params: { q: this.query() },
}));

onSubmit() {
  this.search.trigger(); // now it fetches, with the current query()
}`;

  protected readonly options = `readonly posts = queryResource<Post[]>(() => ({ url: '/api/posts' }), {
  defaultValue: [],
  keepPrevious: true,
  refresh: { interval: 60_000, onFocus: true },
  retry: 3,
  onError: (err) => isDevMode() && console.error(err),
});`;

  protected readonly onError = `queryResource<Data>(() => ({ url: '/api/data' }), {
  retry: 3,
  onError: (err, retryCount, isFinal) => {
    if (!isFinal) {
      if (isDevMode()) console.warn(\`attempt \${retryCount + 1} failed\`, err);
      return; // per-attempt telemetry only
    }
    toaster.error('Could not load data.'); // retries spent, tell the user
  },
});`;

  protected readonly prefetch = `<a
  (mouseenter)="posts.prefetch({ url: '/api/posts/' + id() })"
  [routerLink]="['/posts', id()]"
>
  {{ '{' }}{{ '{' }} title() {{ '}' }}{{ '}' }}
</a>`;

  protected readonly disabledReason = `@switch (posts.disabledReason()) {
  @case ('offline') {
    <p>You're offline. Cached posts shown below.</p>
  }
  @case ('circuit-open') {
    <p>The posts service is having trouble. Retrying soon…</p>
  }
  @default {
    <!-- 'no-request' or null: render normally -->
    <post-list [posts]="posts.value()" />
  }
}`;

  protected readonly setLocal = `readonly user = queryResource<User>(() => \`/api/users/\${this.id()}\`, {
  parse: (raw) => new User(raw), // a class instance, not a plain object
});

// updates memory only; skips IndexedDB persist and cross-tab broadcast
this.user.setLocal(new User({ ...raw, seen: true }));`;

  protected readonly noDedupe = `import { noDedupe } from '@mmstack/resource';

readonly probe = queryResource<Health>(() => ({
  url: '/api/health',
  context: noDedupe(), // this request always reaches the network
}));`;
}
