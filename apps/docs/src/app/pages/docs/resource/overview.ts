import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Resource"
      pkg="@mmstack/resource"
      lead="Data fetching for Angular, expressed with signals instead of RxJS. Caching, retries, refresh intervals, circuit breakers, request deduplication, and optimistic mutations, all opt-in one feature at a time."
    >
      <p>
        Fetching data in a component is rarely just the fetch. You end up
        writing the same supporting cast every time: a loading flag, an error
        branch, a cache so two components asking for the same thing don't hit
        the network twice, a retry for the flaky endpoint, a refetch when the
        user comes back to the tab. <code>&#64;mmstack/resource</code> is that
        supporting cast, built on Angular's own <code>httpResource</code> and
        driven by signals.
      </p>
      <p>
        If you know TanStack Query from the React side, this covers the same
        ground. The difference is the surface: no <code>useQuery</code> hook
        rules, no observables to subscribe and unsubscribe. A resource is a
        bundle of signals you read in a template, and it cleans itself up with
        the component.
      </p>

      <docs-code [code]="install" lang="bash" />

      <p>
        The design is opt-in feature by feature. A bare
        <code>queryResource()</code> with no options behaves exactly like
        <code>httpResource</code>. Cache, retry, refresh, and circuit breaker
        are independent knobs you add only where a call needs them, so a simple
        read stays simple.
      </p>

      <docs-section title="One look at the shape" id="shape">
        <p>
          Here is a read and a write side by side. The read fetches on its own
          and refetches when its request function returns something new; the
          write waits for you to call <code>mutate()</code> and updates the
          list optimistically. Don't worry about every option yet, just notice
          that both give you back signals you read directly.
        </p>
        <docs-code [code]="shape" lang="ts" />
        <p>
          <code>posts.value()</code>, <code>posts.status()</code>, and
          <code>posts.error()</code> are signals, so a template that reads them
          re-renders when the fetch moves. That is the whole read side.
          <a mmLink="/docs/resource/query">queryResource</a> and
          <a mmLink="/docs/resource/mutation">mutationResource</a> each get
          their own page below.
        </p>
      </docs-section>

      <docs-section title="Setup" id="setup">
        <p>
          A plain <code>queryResource()</code> needs nothing but
          <code>provideHttpClient()</code>, and an in-memory cache is wired up
          for you. To turn on caching (dedup, stale-while-revalidate,
          persistence), register the cache and dedupe interceptors and opt
          resources in. That, plus <code>provideQueryCache()</code> for a
          persistent or cross-tab cache, is covered on the
          <a mmLink="/docs/resource/caching">caching</a> page.
        </p>
      </docs-section>

      <docs-section title="Picking a resource" id="picking">
        <p>
          Five flavors cover the shapes fetching tends to take. All are built
          on <code>httpResource</code> and hand back a ref of signals with at
          least <code>value()</code>, <code>status()</code>, and
          <code>error()</code>. The difference is what makes them run.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Reach for</th>
              <th>It runs on</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read data, cached and refreshable</td>
              <td><a mmLink="/docs/resource/query"><code>queryResource</code></a></td>
              <td>Its request function returning a new value</td>
            </tr>
            <tr>
              <td>Read, but only when asked</td>
              <td><a mmLink="/docs/resource/query"><code>manualQueryResource</code></a></td>
              <td>An explicit <code>.trigger()</code></td>
            </tr>
            <tr>
              <td>Write data, optimistically</td>
              <td><a mmLink="/docs/resource/mutation"><code>mutationResource</code></a></td>
              <td>An explicit <code>.mutate(value)</code></td>
            </tr>
            <tr>
              <td>Paginate, accumulating pages</td>
              <td><a mmLink="/docs/resource/infinite-query"><code>infiniteQueryResource</code></a></td>
              <td><code>.fetchNextPage()</code></td>
            </tr>
            <tr>
              <td>Read a live connection (SSE or WebSocket)</td>
              <td><a mmLink="/docs/resource/streaming"><code>streamResource</code></a></td>
              <td>Every message on the wire</td>
            </tr>
          </tbody>
        </table>
        <p>
          When in doubt, start with <code>queryResource</code>. It is the one
          you will reach for most, and the others are variations on the same
          theme.
        </p>
      </docs-section>

      <docs-section title="Recipes" id="recipes">
        <p>
          A few common tasks, each with the real API. Follow the links for the
          full story on any of them.
        </p>

        <h3>Stale-while-revalidate list</h3>
        <p>
          Show the cached list instantly, refresh it in the background, and
          hold the old value so the view never flashes empty on reload.
          <code>keepPrevious</code> is the flag that keeps
          <code>value()</code> populated while a refetch is in flight.
        </p>
        <docs-code [code]="swrRecipe" lang="ts" />

        <h3>Poll while the tab is visible, refresh on return</h3>
        <p>
          The object form of <code>refresh</code> combines an interval with
          event triggers. This polls once a minute and also refetches the
          moment the user switches back to the tab.
        </p>
        <docs-code [code]="pollRecipe" lang="ts" />

        <h3>Optimistic add with rollback</h3>
        <p>
          Apply the change to the list before the server confirms, keep the old
          list as context, and restore it if the request fails.
          <code>untracked()</code> reads the current value without subscribing
          to it. Full walkthrough on the
          <a mmLink="/docs/resource/mutation">mutation</a> page.
        </p>
        <docs-code [code]="optimisticRecipe" lang="ts" />

        <h3>Per-user cache</h3>
        <p>
          Two users share a URL but must not share cached responses. Opt the
          <code>Authorization</code> header into the cache key with
          <code>varyHeaders</code> so each user gets their own entry. The
          header value is one-way digested into the key, never stored raw.
        </p>
        <docs-code [code]="varyRecipe" lang="ts" />

        <h3>Circuit breaker around a flaky endpoint</h3>
        <p>
          After a threshold of failures, stop hammering the endpoint and let it
          recover. Share one breaker across every resource hitting that service
          so one trip protects all of them. See
          <a mmLink="/docs/resource/caching">circuit breakers</a> for the
          states and recovery.
        </p>
        <docs-code [code]="cbRecipe" lang="ts" />
      </docs-section>

      <docs-section title="Global defaults" id="defaults">
        <p>
          When most of your resources want the same options, set them once
          instead of repeating them per call. Defaults layer in three tiers,
          and a per-call option always wins over both providers.
        </p>
        <p>
          <code>provideResourceOptions()</code> is the base layer: it applies to
          every resource kind (queries, mutations, streams) and covers the
          common options <code>register</code>, <code>retry</code>,
          <code>circuitBreaker</code>, and <code>triggerOnSameRequest</code>.
          <code>provideQueryResourceOptions()</code> and
          <code>provideMutationResourceOptions()</code> sit above it, scoped to
          their one kind and inheriting from the base. Precedence runs call site
          first, then the type-specific provider, then the common provider, so
          you can make "every query participates in transitions" the default and
          still turn it off for the odd one with <code>register: false</code>.
        </p>
        <docs-code [code]="defaults" lang="ts" />
        <p>
          Each provider takes a value or a factory (<code>() =&gt; options</code>).
          Circuit breakers have their own default hook,
          <code>provideCircuitBreakerDefaultOptions()</code>: every
          <code>createCircuitBreaker()</code> call without explicit options picks
          up the threshold and timeout you set there.
        </p>
      </docs-section>

      <docs-section title="Works with transitions" id="transitions">
        <p>
          Resources plug into the transition scopes from
          <a mmLink="/docs/primitives/transitions">&#64;mmstack/primitives</a>.
          Set <code>register</code> and a resource joins the nearest
          <code>&lt;mm-suspense&gt;</code> boundary or transition outlet, so its
          loading state coordinates with the rest of the subtree instead of
          flashing a spinner on its own. Pair it with
          <code>keepPrevious</code> and reloads hold the last view while the
          fresh one loads.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class ResourceOverview {
  protected readonly install = 'npm install @mmstack/resource';

  protected readonly defaults = `import {
  provideResourceOptions,
  provideQueryResourceOptions,
  provideMutationResourceOptions,
} from '@mmstack/resource';

providers: [
  // layer 1: every resource kind
  provideResourceOptions({ retry: { max: 2 }, register: 'indicator' }),
  // layer 2: queries only (inherits + overrides layer 1)
  provideQueryResourceOptions({ circuitBreaker: true }),
  // layer 2: mutations only
  provideMutationResourceOptions({ register: false }),
];`;

  protected readonly shape = `import { queryResource, mutationResource } from '@mmstack/resource';
import { untracked } from '@angular/core';

type Post = { id: number; title: string };

// a read: fetches on init, refetches when the URL changes
readonly posts = queryResource<Post[]>(() => '/api/posts', {
  defaultValue: [],
});

// a write: fires on mutate(), updates the list without waiting
readonly addPost = mutationResource(
  (post: Post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    onMutate: (post) => this.posts.update((all) => [...all, post]),
  },
);`;

  protected readonly swrRecipe = `readonly posts = queryResource<Post[]>(() => ({ url: '/api/posts' }), {
  defaultValue: [],
  cache: { staleTime: 60_000 }, // fresh for a minute, then revalidate on read
  keepPrevious: true, // hold the last list while the refresh runs
});`;

  protected readonly pollRecipe = `readonly notifications = queryResource<Note[]>(() => ({ url: '/api/notifications' }), {
  refresh: { interval: 60_000, onFocus: true },
});`;

  protected readonly optimisticRecipe = `readonly addPost = mutationResource(
  (post: Post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    onMutate: (post) => {
      const prev = untracked(this.posts.value);
      this.posts.set([...prev, post]);
      return prev; // context for rollback
    },
    onError: (_err, prev) => this.posts.set(prev),
  },
);`;

  protected readonly varyRecipe = `queryResource<Profile>(() => ({ url: '/api/me', headers }), {
  cache: { varyHeaders: ['Authorization'] }, // one entry per user
});`;

  protected readonly cbRecipe = `import { createCircuitBreaker } from '@mmstack/resource';

const cb = createCircuitBreaker({ threshold: 5, timeout: 30_000 });

readonly a = queryResource(() => ({ url: '/api/reports' }), { circuitBreaker: cb });
readonly b = queryResource(() => ({ url: '/api/metrics' }), { circuitBreaker: cb });
// five failures on the shared service trips the breaker for both`;
}
