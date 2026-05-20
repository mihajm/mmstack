# @mmstack/resource

[![npm version](https://badge.fury.io/js/%40mmstack%2Fresource.svg)](https://www.npmjs.com/package/@mmstack/resource)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/resource/LICENSE)

`@mmstack/resource` is a signal-native data-fetching layer for Angular built on top of `httpResource`. It adds caching, retries, refresh intervals, circuit breakers, request deduplication, optimistic mutations, and stale-while-revalidate semantics — the surface TanStack Query gives React, but expressed with Angular signals rather than RxJS/Promises.

It's designed to be opt-in feature by feature: starting with `queryResource()` and zero options gives you exactly `httpResource`. Every additional knob (cache, retry, refresh, circuit breaker) is independent and composable.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
  - [Resources](#resources)
  - [Cache + cache keys](#cache--cache-keys)
  - [Stale-while-revalidate](#stale-while-revalidate)
  - [Interceptors](#interceptors)
- [`queryResource`](#queryresource)
- [`mutationResource`](#mutationresource)
- [`manualQueryResource`](#manualqueryresource)
- [Caching](#caching)
- [Circuit breakers](#circuit-breakers)
- [Composition (retry / refresh / keepPrevious)](#composition-retry--refresh--keepprevious)
- [Recipes](#recipes)

## Install

```bash
npm install @mmstack/resource
```

## Quick start

Two-step setup: provide the cache + interceptors in your app config, then create resources in your services or components.

```typescript
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig } from '@angular/core';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideQueryCache,
} from '@mmstack/resource';

export const appConfig: ApplicationConfig = {
  providers: [
    provideQueryCache(),
    provideHttpClient(
      withInterceptors([
        createCacheInterceptor(),
        createDedupeRequestsInterceptor(),
      ]),
    ),
  ],
};
```

```typescript
import { Injectable, isDevMode, untracked } from '@angular/core';
import {
  createCircuitBreaker,
  mutationResource,
  queryResource,
} from '@mmstack/resource';

type Post = { userId: number; id: number; title: string; body: string };

@Injectable({ providedIn: 'root' })
export class PostsService {
  private readonly endpoint = 'https://jsonplaceholder.typicode.com/posts';
  private readonly cb = createCircuitBreaker();

  readonly posts = queryResource<Post[]>(() => ({ url: this.endpoint }), {
    keepPrevious: true,
    refresh: 5 * 60_000,
    circuitBreaker: this.cb,
    retry: 3,
    defaultValue: [],
    onError: (err) => isDevMode() && console.error(err),
  });

  private readonly createPostResource = mutationResource(
    (post: Post) => ({ url: this.endpoint, method: 'POST', body: post }),
    {
      circuitBreaker: this.cb,
      onMutate: (post) => {
        const prev = untracked(this.posts.value);
        this.posts.set([...prev, post]);
        return prev; // ctx for rollback
      },
      onError: (_err, prev) => this.posts.set(prev),
      onSuccess: (saved) =>
        this.posts.update((posts) =>
          posts.map((p) => (p.id === saved.id ? saved : p)),
        ),
    },
  );

  createPost(post: Post) {
    this.createPostResource.mutate(post);
  }
}
```

That's enough for caching, deduping, retries, circuit-breaker protection, and optimistic updates. The rest of the README explains each piece.

## Core concepts

### Resources

The library exposes three resource flavors, all built on `httpResource`:

| Function                | Use for                                         | Triggers on                |
| ----------------------- | ----------------------------------------------- | -------------------------- |
| `queryResource()`       | Reads. Cached, refreshable, retryable.          | Reactive request fn change |
| `mutationResource()`    | Writes. Lifecycle hooks for optimistic updates. | Explicit `.mutate(value)`  |
| `manualQueryResource()` | Reads that should only fire on demand.          | Explicit `.trigger()`      |

All three return a signal-typed ref — `value()`, `status()`, `error()`, `headers()`, `statusCode()`, plus per-flavor extras (`prefetch`, `mutate`, `trigger`).

### Cache + cache keys

When the cache interceptor is registered (`createCacheInterceptor()`) and a query resource opts in via `cache`, responses are stored in the shared `Cache` keyed by a string derived from the request.

**Default key**: produced by `hashRequest()` (`util/hash-request.ts`). Composition is `${method}:${url}:${responseType}[:${params}][:${body}]` — sorted query params, stable body hashing (incl. `File`/`Blob`/`FormData`/`URLSearchParams`/`ArrayBuffer` markers). **It does not include headers or `HttpContext`.**

If two requests should _not_ share a cache entry but the default key would collide (e.g. different `Authorization` headers), pass a custom hash:

```typescript
queryResource<Post>(() => ({ url, headers }), {
  cache: {
    hash: (req) =>
      `${hashRequest(req)}:${(req.headers as HttpHeaders | undefined)?.get('Authorization') ?? ''}`,
  },
});
```

> **Note:** A custom `parse()` does not affect the cache key. Two requests that share a URL but parse differently will share a cache entry containing the _raw_ server response; the parser is applied to the cached value on read.

### Stale-while-revalidate

Cache entries have two durations:

- **`staleTime`** — how long the entry is fresh. Reads within this window return cached data and _do not refetch_.
- **`ttl`** — how long the entry lives in the cache at all. After `ttl`, the entry is evicted.

Between `staleTime` and `ttl`, the cached value is **stale-but-valid**: the resource returns it immediately, then triggers a background fetch to revalidate. Consumers see the cached value first, then the fresh value when it lands.

HTTP `Cache-Control` and `ETag`/`Last-Modified` headers are respected by default. A response with `s-maxage=60` will be considered fresh for 60s, `stale-while-revalidate=300` extends the stale window by 5 min, and 304 responses are honored. To opt out per-resource, pass `cache: { ignoreCacheControl: true }`.

### Interceptors

Two interceptors ship with the library, both registered via `withInterceptors([...])`:

```typescript
withInterceptors([
  createCacheInterceptor(), // 1. cache lookup + store
  createDedupeRequestsInterceptor(), // 2. dedupe in-flight requests
]);
```

Order matters but only weakly: the cache interceptor short-circuits cached responses before they reach the network, the dedupe interceptor coalesces identical in-flight requests so duplicate consumers share one network round-trip. The order above is the safe default.

Both default to intercepting only GET. Pass an array to extend: `createCacheInterceptor(['GET', 'HEAD'])`.

To opt a single request out of dedup, attach `noDedupe()` to its context:

```typescript
queryResource(() => ({
  url: '/api/data',
  context: noDedupe(),
}));
```

## `queryResource`

```ts
queryResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | string | undefined,
  options?: QueryResourceOptions<TResult, TRaw>,
): QueryResourceRef<TResult>
```

`request` is a reactive function. Whenever it returns a new value, a new request is made; returning `undefined` disables the resource until the function returns something again.

### Options

| Option                 | Type                                                   | Default            | What it does                                                                                                   |
| ---------------------- | ------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `defaultValue`         | `TResult`                                              | –                  | Initial value before the first request resolves. When set, `value()` is `TResult`, not `TResult \| undefined`. |
| `keepPrevious`         | `boolean`                                              | `false`            | Hold the previous `value`, `status`, and `headers` while a refresh is in flight. Powered by `linkedSignal`.    |
| `refresh`              | `number` (ms)                                          | –                  | Auto-refetch interval.                                                                                         |
| `retry`                | `number \| { max, backoff }`                           | `0`                | On failure, retry N times with exponential backoff (default 1000ms × 2^n).                                     |
| `onError`              | `(err, retryCount, isFinal) => void`                   | –                  | Called on **every** failed attempt. `retryCount` is the number of retries already done (`0` on the first failure). `isFinal` is `true` when no further retry will be scheduled — branch on it to separate per-attempt instrumentation from "user-needs-to-know" side effects. |
| `circuitBreaker`       | `true \| CircuitBreaker \| { threshold?, timeout?, … }` | off                | See [circuit breakers](#circuit-breakers).                                                                     |
| `cache`                | `ResourceCacheOptions`                                 | off                | Enables caching for this resource. See [caching](#caching).                                                    |
| `triggerOnSameRequest` | `boolean`                                              | `false`            | Re-run even if the request object equals the previous one. Use sparingly.                                      |
| `equal`                | `ValueEqualityFn<TResult>`                             | `Object.is`        | Custom equality for the result value (forwarded to `httpResource`).                                            |
| `injector`             | `Injector`                                             | `inject(Injector)` | Use this injector for cache/circuit-breaker resolution. Required if calling outside an injection context.      |
| `parse`                | `(raw: TRaw) => TResult`                               | identity           | Transform the raw HTTP response. Does not affect cache keys.                                                   |

### Return shape (`QueryResourceRef<T>`)

| Member       | Type                                       | Notes                                                                                         |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `value`      | `WritableSignal<T>`                        | The current value. Writable so optimistic mutations can update it.                            |
| `status`     | `Signal<ResourceStatus>`                   | `'idle' \| 'loading' \| 'error' \| 'reloading' \| 'resolved' \| …`                            |
| `error`      | `Signal<unknown>`                          | –                                                                                             |
| `headers`    | `WritableSignal<HttpHeaders \| undefined>` | Held when `keepPrevious: true`.                                                               |
| `statusCode` | `WritableSignal<number \| undefined>`      | –                                                                                             |
| `isLoading`  | `Signal<boolean>`                          | –                                                                                             |
| `hasValue`   | `Signal<boolean>`                          | –                                                                                             |
| `disabled`       | `Signal<boolean>`                                       | `true` when network is offline, circuit breaker is open, or `request()` returned `undefined`. |
| `disabledReason` | `Signal<'offline' \| 'circuit-open' \| 'no-request' \| null>` | Why the resource is disabled. `null` when enabled. Branch your UI on this rather than parsing combined state. |
| `reload`     | `() => void`                               | Force a refetch (ignores `staleTime` for the next request).                                   |
| `prefetch`   | `(req?) => Promise<void>`                  | Warm the cache without subscribing. Silently skips on slow connections (`saveData` / 2g).     |
| `destroy`    | `() => void`                               | –                                                                                             |

## `mutationResource`

```ts
mutationResource<TResult, TRaw, TMutation, TCTX, TICTX>(
  request: (params: TMutation) => HttpResourceRequest | undefined,
  options?: MutationResourceOptions<...>,
): MutationResourceRef<TResult, TMutation, TICTX>
```

Unlike `queryResource`, a mutation only fires when you call `.mutate(value)`. It cannot be cached (and intentionally rejects `cache`, `keepPrevious`, and `refresh` options).

### Lifecycle hooks

```typescript
mutationResource(
  (post: Post) => ({ url: '/posts', method: 'POST', body: post }),
  {
    onMutate: (post, initialCtx) => {
      // 1. fires synchronously before the request
      // return a ctx value that's passed to the other hooks
      const prev = untracked(this.posts.value);
      this.posts.set([...prev, post]);
      return prev;
    },
    onError: (err, ctx /* = prev */) => {
      // 2a. fires on failure — use ctx to roll back
      this.posts.set(ctx);
    },
    onSuccess: (saved, ctx) => {
      // 2b. fires on success — replace the optimistic entry with server truth
      this.posts.update((posts) =>
        posts.map((p) => (p.id === saved.id ? saved : p)),
      );
    },
    onSettled: (ctx) => {
      // 3. fires after either branch — cleanup, refetch, etc.
    },
  },
);
```

The `TCTX` returned from `onMutate` flows into `onError` / `onSuccess` / `onSettled`. The optional `initialCtx` second arg to `.mutate(value, initialCtx)` flows into `onMutate` as its second argument.

### Queuing

By default, calling `.mutate()` while another mutation is in flight starts immediately — concurrent mutations run in parallel. With `queue: true`, mutations are serialized:

```typescript
mutationResource(request, { queue: true });
```

Queued mutations sit in a signal-backed queue and execute one at a time. The queue **persists across resource-disabled states** — if the circuit breaker opens or the network drops, queued mutations stay pending and run when the resource recovers. This is intentional for resilience (think "POST goes out when we're back online"), but it does mean a queued mutation can fire long after the user triggered it. Don't enable `queue` if that's surprising in your UX.

### Return shape (`MutationResourceRef<T, TMutation>`)

| Member                                        | Type                        | Notes                                                  |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `mutate`                                      | `(value, ctx?) => void`     | Trigger the mutation.                                  |
| `current`                                     | `Signal<TMutation \| null>` | The value currently being mutated (or `null` if idle). |
| `status` / `error` / `isLoading` / `disabled` | as in `QueryResourceRef`    | –                                                      |

(Mutations deliberately don't expose `value`, `hasValue`, `set`, `update`, or `prefetch` — those don't make sense for one-off writes.)

## `manualQueryResource`

Same shape as `queryResource`, but only fires when you call `.trigger()`. Useful for searches, "load more" buttons, and any read that shouldn't fire on construction.

```typescript
const search = manualQueryResource<SearchResult[]>(() => ({
  url: '/api/search',
  params: { q: this.query() },
}));

// in a handler:
onSubmit() {
  search.trigger();
}
```

`.trigger()` re-evaluates the `request()` function and fires. Everything else (`value`, `status`, `error`, retry, cache, etc.) works identically.

## Caching

### `provideQueryCache(options?)`

Registers the shared `Cache` in the root injector.

```typescript
provideQueryCache({
  staleTime: 60_000, // default freshness, default: 1 hour
  ttl: 5 * 60_000, // default eviction, default: same as staleTime
  cacheSize: 100, // max entries before LRU eviction
  persist: true, // mirror to IndexedDB
  version: 1, // bumping invalidates persisted entries
  syncTabs: true, // sync invalidations across tabs via BroadcastChannel
});
```

### `ResourceCacheOptions` (per-resource `cache: { … }`)

| Field                | Default                  | Notes                                                                                                                |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `staleTime`          | from `provideQueryCache` | Per-resource override.                                                                                               |
| `ttl`                | from `provideQueryCache` | Per-resource override.                                                                                               |
| `hash`               | `hashRequest`            | Custom cache key function. See [cache + cache keys](#cache--cache-keys).                                             |
| `persist`            | `false`                  | Mirror this resource's responses to IndexedDB (only effective if the cache itself was created with `persist: true`). |
| `ignoreCacheControl` | `false`                  | Ignore HTTP `Cache-Control` directives and use only `staleTime`/`ttl`.                                               |

Pass `cache: true` as a shorthand for "use the cache with defaults," or `cache: { … }` for fine-tuning.

### IndexedDB persistence

When `provideQueryCache({ persist: true })` is set, the cache mirrors entries to IndexedDB on write and rehydrates on app start. Entries that are still fresh come back as if the page never reloaded.

Bumping `version` invalidates the entire persisted store — useful when your response shapes change. The cache stores `Cache-Control` metadata alongside the value, so persisted entries respect the same freshness rules as in-memory ones.

You can also opt-in to persistance on a per-resource basis via the cache settings.

`HttpHeaders` and `HttpParams` are serialized to plain objects for storage. Non-serializable values in headers (functions, references) are dropped silently — if you depend on something custom in headers, use a custom `hash` instead of relying on persistence to round-trip it.

### Cross-tab sync

With `syncTabs: true`, cache invalidations and updates broadcast via `BroadcastChannel`. Tab A writes a fresh response, Tab B sees it — no extra network call. SSR-safe (the channel is created only in the browser).

### Manual control: `injectQueryCache()`

```typescript
const cache = injectQueryCache<MyResponse>();
cache.invalidate('GET /api/posts'); // drop one entry by key
cache.invalidateAll(); // drop everything
cache.store(key, value, staleTime, ttl); // imperative write
```

Useful for "log out → invalidate all user-scoped queries" or "mutation succeeds → invalidate a specific list."

## Circuit breakers

A circuit breaker pauses requests to an endpoint after a configurable number of failures and tries again after a timeout. Three states:

- **`CLOSED`** — normal operation, requests go through.
- **`OPEN`** — failure threshold hit; new requests are short-circuited (the resource's `disabled()` returns `true`).
- **`HALF_OPEN`** — after the timeout, one probe request is allowed. Success → back to `CLOSED`, failure → back to `OPEN`.

```typescript
const cb = createCircuitBreaker({
  threshold: 5, // open after 5 failures
  timeout: 30_000, // probe after 30s
  shouldFail: (err) => true, // which errors count as failures
  shouldFailForever: (err) => false, // which errors permanently break the circuit (e.g. 401)
});

queryResource(() => ({ url: '/api/data' }), { circuitBreaker: cb });
mutationResource(() => ({ url: '/api/posts', method: 'POST' }), {
  circuitBreaker: cb,
});
```

Sharing one `cb` across multiple resources means a flaky endpoint trips the breaker once and protects every consumer. Per-resource breakers (`circuitBreaker: true` or `circuitBreaker: { threshold: 3 }`) create independent state.

> The misspelled `treshold` field is still accepted as a deprecated alias for `threshold` (it'll be removed in a future major).

### App-wide defaults

```typescript
provideCircuitBreakerDefaultOptions({
  threshold: 10,
  timeout: 60_000,
});
```

Every `createCircuitBreaker()` call without explicit options will pick these up.

### `shouldFailForever` and `hardReset()`

For errors that won't resolve themselves (401 with an invalid token, 403 from a permission boundary), `shouldFailForever` permanently opens the breaker — no probe retries, no timeout. The resource stays `disabled` until you explicitly recover.

```typescript
const cb = createCircuitBreaker({
  shouldFailForever: (err) =>
    err instanceof HttpErrorResponse && [401, 403].includes(err.status),
});
```

To recover (e.g. after the user re-authenticates), call `hardReset()`:

```typescript
authService.refreshToken().subscribe(() => {
  cb.hardReset(); // clears failure count, drops permanent-open, breaker back to CLOSED
});
```

`hardReset()` is also useful for testing — it gives you a "back to factory state" handle without reconstructing the breaker.

## Composition (retry / refresh / keepPrevious)

The wrappers stack in a fixed order inside `queryResource`:

```
request -> stableRequest (network + circuit breaker gate)
        -> httpResource
        -> retryOnError    (retries on every failure up to `retry.max`)
        -> refreshOnInterval (re-runs every `refresh` ms)
        -> persistResourceValues (carries previous value/headers/status forward when `keepPrevious`)
```

Practical consequences:

- **`retry` and `refresh` are independent.** A retry exhaustion doesn't disable refresh; a successful refresh resets the retry counter for the next failure.
- **`keepPrevious` works alongside both.** While a retry or refresh is in flight, `value()` is the previous successful result, not `undefined`.
- **Circuit breaker beats retry.** If the breaker opens during a retry sequence, the resource is disabled — no more retries until the breaker probes and closes.

## Recipes

### Optimistic update with rollback

The Quick Start example covers this — `onMutate` returns the previous value as ctx, `onError` restores it. The key detail: read the previous value with `untracked()` so you don't create a spurious dependency.

### Manual invalidation after a mutation

```typescript
const cache = injectQueryCache();
mutationResource((p: Post) => ({ url: '/posts', method: 'POST', body: p }), {
  onSuccess: () => {
    // Drop every paginated `GET /posts*` cache entry in one shot.
    cache.invalidatePrefix('GET /posts');
    // Or, for arbitrary predicates:
    // cache.invalidateWhere((key) => key.includes('/posts'));
  },
});
```

`invalidate(key)` drops a single entry, `invalidatePrefix(prefix)` drops every key starting with the prefix (most common after list-mutating writes), and `invalidateWhere(predicate)` handles anything else. Both bulk variants return the number of entries removed.

### Prefetch on hover

```typescript
@Component({
  template: `
    <a
      (mouseenter)="posts.prefetch({ url: '/posts/' + id() })"
      [routerLink]="['/posts', id()]"
    >
      {{ title() }}
    </a>
  `,
})
export class PostLink {
  readonly id = input.required<number>();
  readonly title = input.required<string>();
  readonly posts = injectPostsResource();
}
```

`prefetch()` skips automatically on slow connections (`navigator.connection.saveData`, `effectiveType: '2g'`), so this is safe to wire up without conditional checks.

### Polling with backoff on error

```typescript
queryResource(() => ({ url: '/api/job-status' }), {
  refresh: 5_000,
  retry: { max: 3, backoff: 2_000 },
  circuitBreaker: { threshold: 5, timeout: 60_000 },
});
```

Five-second refresh; on failure, retry three times with exponential backoff starting at 2s; if five consecutive failures stack up, the circuit breaker pauses polling for a minute.

### Branching UI on `disabledReason`

```typescript
@Component({
  template: `
    @switch (posts.disabledReason()) {
      @case ('offline') {
        <p>You're offline. Cached posts shown below.</p>
      }
      @case ('circuit-open') {
        <p>The posts service is having trouble. Retrying soon…</p>
      }
      @default {
        <ul>
          @for (p of posts.value(); track p.id) {
            <li>{{ p.title }}</li>
          }
        </ul>
      }
    }
  `,
})
export class PostsList {
  readonly posts = injectPostsResource();
}
```

### Retry-aware logging vs user-facing errors

```typescript
queryResource(() => ({ url: '/api/data' }), {
  retry: 3,
  onError: (err, retryCount, isFinal) => {
    if (!isFinal) {
      // Per-attempt log, only useful in dev or for telemetry
      if (isDevMode()) console.warn(`Attempt ${retryCount + 1} failed`, err);
      return;
    }
    // Final failure (retries exhausted, or retry=0) — the "user needs to know" path
    toaster.error('Could not load data. Please try again.');
    Sentry.captureException(err);
  },
});
```

### Recovering a permanently-tripped circuit breaker

```typescript
const cb = createCircuitBreaker({
  shouldFailForever: (err) =>
    err instanceof HttpErrorResponse && err.status === 401,
});

// elsewhere, after re-auth:
authService.onRefresh(() => cb.hardReset());
```

### Reading the cache directly (e.g. in a guard)

```typescript
export const userGuard = () => {
  const cache = injectQueryCache<User>();
  const cached = cache.getUntracked('GET /me');
  if (cached) return true;
  return inject(Router).parseUrl('/login');
};
```

`getUntracked` reads without subscribing — important inside guards where reactivity could cause re-entrancy.
