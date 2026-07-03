import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-caching',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Caching and resilience"
      pkg="@mmstack/resource"
      lead="A shared cache with stale-while-revalidate, keyed by the request. Plus circuit breakers to stop hammering an endpoint that is already failing."
    >
      <p>
        Two components that ask for the same URL shouldn't hit the network
        twice, and a list you saw a second ago shouldn't blank out while it
        reloads. The cache handles both. It stores responses keyed by the
        request, serves them instantly while they are fresh, and revalidates in
        the background once they go stale. Circuit breakers cover the other
        failure mode: an endpoint that is down, where retrying just adds load.
      </p>
      <p>
        Caching is off until you opt in. That is deliberate, so a resource does
        exactly what you asked and nothing implicit. Turning it on is two steps.
      </p>

      <docs-section title="Turning it on" id="on">
        <p>
          Register <code>createCacheInterceptor()</code> in the HTTP client,
          then opt a resource in with the <code>cache</code> option. Pass
          <code>cache: true</code> for the defaults, or an object to tune the
          key and durations.
        </p>
        <docs-code [code]="on" lang="ts" />
        <p>
          The interceptor only touches GET by default. Pass an array to widen
          it, for example <code>createCacheInterceptor(['GET', 'HEAD'])</code>.
          For a persistent, cross-tab, or tuned cache, add
          <code>provideQueryCache()</code>, covered further down.
        </p>
      </docs-section>

      <docs-section title="Stale-while-revalidate" id="swr">
        <p>
          A cache entry has two clocks, and the gap between them is where the
          good behavior lives. <code>staleTime</code> is how long the entry is
          considered fresh: reads inside it return cached data and skip the
          network entirely. <code>ttl</code> is how long the entry lives at all;
          after it, the entry is evicted.
        </p>
        <p>
          Between the two, the value is stale-but-valid. A read gets the cached
          value immediately, and the resource kicks off a background refetch.
          The consumer sees the old value first, then the fresh one when it
          lands. No spinner, no empty state, and the data still ends up current.
        </p>
        <docs-code [code]="swr" lang="ts" />
        <p>
          HTTP <code>Cache-Control</code>, <code>ETag</code>, and
          <code>Last-Modified</code> are honored by default, so a server saying
          <code>stale-while-revalidate=300</code> extends the stale window on
          its own. To ignore server directives and use only your
          <code>staleTime</code> and <code>ttl</code>, pass
          <code>cache: {{ '{' }} ignoreCacheControl: true {{ '}' }}</code>.
        </p>
      </docs-section>

      <docs-section title="Cache keys" id="keys">
        <p>
          The default key comes from <code>hashRequest()</code>: method, URL,
          and response type, plus sorted params and a stable hash of the body.
          It does not include headers. That is usually right, but it bites in
          one case, when the same URL returns different data per header.
        </p>
        <p>
          Two logged-in users hitting <code>/api/me</code> would share a cache
          entry and see each other's data. Opt the distinguishing header into
          the key with <code>varyHeaders</code> and each user gets their own
          entry.
        </p>
        <docs-code [code]="vary" lang="ts" />
        <p>
          Header values are one-way digested into the key, never stored raw,
          because keys are persisted to IndexedDB and broadcast across tabs and
          must not leak secrets. Even so, call
          <code>injectQueryCache().clear()</code> on logout: the previous user's
          entries become unreachable under the new key but linger until their
          TTL. For full control over the key (ignoring a param, a custom shape)
          pass a <code>hash</code> function, which takes precedence over
          <code>varyHeaders</code>.
        </p>
        <docs-code [code]="hash" lang="ts" />
      </docs-section>

      <docs-section title="Recipe: scope the cache to a user or tenant" id="namespace">
        <p>
          In a multi-tenant or multi-user app, one cache shared across
          identities is a data-leak waiting to happen, and a persisted cache
          makes it outlive the session. The fix is to fold the current identity
          into every key. Build your key from the exported
          <code>hashRequest</code> and prepend the Keycloak <code>sub</code> (and
          a tenant id if you have one). This is the pattern the library nudges
          you toward instead of putting <code>Authorization</code> in
          <code>varyHeaders</code>, since a rotating token would churn the cache
          on every refresh while a stable <code>sub</code> does not.
        </p>
        <docs-code [code]="nsHash" lang="ts" />
        <p>
          Prepending with ordinary characters is safe: the key still carries its
          URL structure, so <code>invalidateUrlPrefix</code> keeps working.
          When the identity changes, drop the old entries. On logout
          <code>clear()</code> everything; on a tenant switch, invalidate just
          the previous prefix so the incoming tenant starts clean without
          nuking anything already loaded for it.
        </p>
        <docs-code [code]="nsClear" lang="ts" />
      </docs-section>

      <docs-section title="Persistence and cross-tab sync" id="persist">
        <p>
          <code>provideQueryCache()</code> replaces the default in-memory cache
          with one you can tune and persist. Set <code>persist: true</code> and
          the cache mirrors entries to IndexedDB, so still-fresh data comes back
          after a reload as if the page never went away. Bump
          <code>version</code> to invalidate the whole persisted store when your
          response shapes change.
        </p>
        <docs-code [code]="provide" lang="ts" />
        <p>
          <code>syncTabs: true</code> broadcasts invalidations and updates over
          <code>BroadcastChannel</code>: tab A writes a fresh response and tab B
          sees it without a second network call. Both features are SSR-safe,
          since the IndexedDB store and the channel are only created in the
          browser.
        </p>
      </docs-section>

      <docs-section title="Invalidating by hand" id="invalidate">
        <p>
          Most invalidation should be the declarative
          <code>invalidates</code> option on a
          <a mmLink="/docs/resource/mutation">mutation</a>. For the cases it
          can't express (a guard reading the cache, an arbitrary predicate),
          reach for <code>injectQueryCache()</code>.
        </p>
        <docs-code [code]="inject" lang="ts" />
        <p>
          <code>invalidateUrlPrefix()</code> is the common move: it recovers the
          URL field from the key structurally, so it matches any HTTP method.
          <code>invalidatePrefix()</code> is the lower-level cousin, matching the
          raw key string from its start (useful when your custom
          <code>hash</code> prepends a stable namespace and you want to drop just
          that segment). <code>invalidate(key)</code> drops a single entry by its
          exact key, <code>invalidateWhere()</code> takes an arbitrary predicate,
          and <code>clear()</code> drops everything (memory, persisted rows,
          other tabs), which is what you want on logout. Treat keys as opaque;
          don't hand-build them.
        </p>
      </docs-section>

      <docs-section title="Two more per-resource knobs" id="cache-options">
        <p>
          Alongside <code>staleTime</code>, <code>ttl</code>, <code>hash</code>,
          <code>varyHeaders</code>, <code>persist</code>, and
          <code>ignoreCacheControl</code>, the <code>cache</code> object carries
          two situational flags.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Option</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>skipTabSync</code></td>
              <td>
                Don't broadcast this resource's writes to other tabs even when
                <code>syncTabs</code> is on globally. Lets you opt into cross-tab
                sync app-wide and opt one resource out. Pair with
                <code>persist: true</code> for "persist but don't sync".
              </td>
            </tr>
            <tr>
              <td><code>bustBrowserCache</code></td>
              <td>
                Append a unique query parameter so the browser's own HTTP cache
                is bypassed and the request always reaches the server. The
                parameter is stripped before the cache key is computed, so it
                doesn't fragment your entries.
              </td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="Circuit breakers" id="circuit-breakers">
        <p>
          When an endpoint is failing, retrying is worse than waiting: you add
          load to a service that is already struggling. A circuit breaker trips
          after a threshold of failures and short-circuits new requests until a
          timeout passes, then lets one probe through to test the waters.
        </p>
        <p>Three states:</p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>State</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>CLOSED</code></td>
              <td>Normal. Requests go through.</td>
            </tr>
            <tr>
              <td><code>OPEN</code></td>
              <td>
                Threshold hit. New requests are short-circuited and the
                resource's <code>disabled()</code> is <code>true</code>.
              </td>
            </tr>
            <tr>
              <td><code>HALF_OPEN</code></td>
              <td>
                After the timeout, one probe is allowed. Success closes the
                breaker; failure reopens it.
              </td>
            </tr>
          </tbody>
        </table>
        <docs-code [code]="cb" lang="ts" />
        <p>
          Share one breaker across every resource hitting the same service and
          a single trip protects all of them. Pass
          <code>circuitBreaker: true</code> (or an options object) instead for a
          breaker private to that one resource.
        </p>
      </docs-section>

      <docs-section title="Errors that won't fix themselves" id="fail-forever">
        <p>
          Some failures aren't transient. A 401 with a bad token or a 403 from a
          permission boundary won't succeed on a probe, so retrying is pointless.
          <code>shouldFailForever</code> opens the breaker permanently for those:
          no timeout, no probe. The resource stays disabled until you explicitly
          recover.
        </p>
        <docs-code [code]="forever" lang="ts" />
        <p>
          <code>hardReset()</code> is the recovery handle. Call it after the
          user re-authenticates and the breaker clears its failure count, drops
          the permanent-open flag, and goes back to <code>CLOSED</code>.
        </p>
      </docs-section>

      <docs-section title="Recipe: polling with a safety valve" id="recipe">
        <p>
          Poll a job's status every five seconds, retry a few times on a blip,
          and if failures pile up, let the circuit breaker pause the polling for
          a minute instead of pounding a dead endpoint. The three options are
          independent, so they compose without stepping on each other.
        </p>
        <docs-code [code]="polling" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class CachingDoc {
  protected readonly on = `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { createCacheInterceptor, queryResource } from '@mmstack/resource';

// 1. register the interceptor
provideHttpClient(withInterceptors([createCacheInterceptor()]));

// 2. opt a resource in
readonly posts = queryResource<Post[]>(() => ({ url: '/api/posts' }), {
  cache: true, // or { staleTime: 60_000, ttl: 5 * 60_000 }
});`;

  protected readonly swr = `import { provideQueryCache } from '@mmstack/resource';

// global defaults
provideQueryCache({
  staleTime: 60_000, // fresh for a minute
  ttl: 5 * 60_000, // evicted after five
});

// or per-resource
queryResource<Post[]>(() => ({ url: '/api/posts' }), {
  cache: { staleTime: 60_000, ttl: 5 * 60_000 },
});`;

  protected readonly vary = `queryResource<Profile>(() => ({ url: '/api/me', headers }), {
  cache: {
    varyHeaders: ['Authorization'], // one cache entry per user
  },
});`;

  protected readonly hash = `queryResource<Post>(() => ({ url }), {
  cache: {
    hash: (req) => \`posts:\${new URL(req.url, location.origin).pathname}\`,
  },
});`;

  protected readonly nsHash = `import { hashRequest } from '@mmstack/resource';

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly auth = inject(AuthStore); // exposes sub() and tenant()

  // prepend the identity so each user/tenant gets its own entries
  private readonly key = (req: HttpResourceRequest) =>
    \`\${this.auth.sub()}:\${this.auth.tenant()}:\${hashRequest(req)}\`;

  readonly profile = queryResource<Profile>(() => ({ url: '/api/me' }), {
    cache: { hash: this.key },
  });
}`;

  protected readonly nsClear = `const cache = injectQueryCache();

// logout: nothing from the old session should survive
cache.clear();

// tenant switch: drop only the previous tenant's entries
cache.invalidateWhere((k) => k.startsWith(\`\${sub}:\${oldTenant}:\`));`;

  protected readonly provide = `provideQueryCache({
  staleTime: 60_000,
  ttl: 5 * 60_000,
  cleanup: { maxSize: 100 }, // LRU eviction cap (default 200)
  persist: true, // mirror to IndexedDB
  version: 1, // bump to invalidate persisted entries
  syncTabs: true, // broadcast across tabs
});`;

  protected readonly inject = `const cache = injectQueryCache();

cache.invalidateUrlPrefix('/api/posts'); // any method, under this URL prefix
cache.invalidatePrefix('tenant-a:'); // raw key string from its start
cache.invalidate(key); // a single entry by exact key
cache.invalidateWhere((key) => key.includes('userId=42')); // arbitrary predicate
cache.clear(); // everything: memory, persisted, other tabs (e.g. on logout)`;

  protected readonly cb = `import { createCircuitBreaker, queryResource } from '@mmstack/resource';

const cb = createCircuitBreaker({
  threshold: 5, // open after 5 failures
  timeout: 30_000, // probe after 30s
});

queryResource(() => ({ url: '/api/data' }), { circuitBreaker: cb });`;

  protected readonly forever = `import { HttpErrorResponse } from '@angular/common/http';

const cb = createCircuitBreaker({
  shouldFailForever: (err) =>
    err instanceof HttpErrorResponse && [401, 403].includes(err.status),
});

// elsewhere, after re-auth:
authService.onRefresh(() => cb.hardReset());`;

  protected readonly polling = `queryResource(() => ({ url: '/api/job-status' }), {
  refresh: 5_000, // poll every 5s
  retry: { max: 3, backoff: 2_000 }, // 3 retries, backoff from 2s
  circuitBreaker: { threshold: 5, timeout: 60_000 }, // pause after 5 failures
});`;
}
