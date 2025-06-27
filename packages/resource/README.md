# @mmstack/resource

[![npm version](https://badge.fury.io/js/%40mmstack%2Fresource.svg)](https://www.npmjs.com/package/@mmstack/resource)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/resource/LICENSE)

`@mmstack/resource` is an Angular library that provides powerful, signal-based primitives for managing asynchronous data fetching and mutations. It builds upon Angular's `httpResource` and offers features like caching, retries, refresh intervals, circuit breakers, and request deduplication, all while maintaining a fine-grained reactive graph. It's inspired by libraries like TanStack Query, but aims for a more Angular-idiomatic and signal-centric approach.

## Features

- **Signal-Based:** Fully integrates with Angular's signal system for efficient change detection and reactivity.
- **Caching:** Built-in caching with configurable TTL (Time To Live) and stale-while-revalidate behavior. Supports custom cache key generation and respects HTTP caching headers.
- **Retries:** Automatic retries on failure with configurable backoff strategies.
- **Refresh Intervals:** Automatically refetch data at specified intervals.
- **Circuit Breaker:** Protects your application from cascading failures by temporarily disabling requests to failing endpoints.
- **Request Deduplication:** Avoids making multiple identical requests concurrently.
- **Mutations:** Provides a dedicated `mutationResource` for handling data modifications, with callbacks for `onMutate`, `onError`, `onSuccess`, and `onSettled`.
- **Prefetching:** Allows you to prefetch data into the cache, improving perceived performance.
- **Extensible:** Designed to be modular and extensible. You can easily add your own custom features or integrate with other libraries.
- **TypeScript Support:** A strong focus on typesafety

## Quick Start

1. Install mmstack-resource

```bash
npm install @mmstack/resource
```

2. Initialize the QueryCache & interceptors (optional)

```typescript
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig } from '@angular/core';
import { createCacheInterceptor, createDedupeRequestsInterceptor, provideQueryCache } from '@mmstack/resource';

export const appConfig: ApplicationConfig = {
  providers: [
    // ..other providers
    provideQueryCache(),
    provideHttpClient(withInterceptors([createCacheInterceptor(), createDedupeRequestsInterceptor()])),
  ],
};
```

3. Use it :)

```typescript
import { Injectable, isDevMode, untracked } from '@angular/core';
import { createCircuitBreaker, mutationResource, queryResource } from '@mmstack/resource';

type Post = {
  userId: number;
  id: number;
  title: string;
  body: string;
};

@Injectable({
  providedIn: 'root',
})
export class PostsService {
  private readonly endpoint = 'https://jsonplaceholder.typicode.com/posts';
  private readonly cb = createCircuitBreaker();
  readonly posts = queryResource<Post[]>(
    () => ({
      url: this.endpoint,
    }),
    {
      keepPrevious: true, // keep data between requests
      refresh: 5 * 60 * 1000, // refresh every 5 minutes
      circuitBreaker: this.cb, // use shared circuit breaker use true if not sharing
      retry: 3, // retry 3 times on error using default backoff
      onError: (err) => {
        if (!isDevMode()) return;
        console.error(err);
      }, // log errors in dev mode
      defaultValue: [],
    },
  );

  private readonly createPostResource = mutationResource(
    (post: Post) => ({
      url: this.endpoint,
      method: 'POST',
      body: post,
    }),
    {
      circuitBreaker: this.cb, // use shared circuit breaker use true if not sharing
      onMutate: (post: Post) => {
        const prev = untracked(this.posts.value);
        this.posts.set([...prev, post]); // optimistically update
        return prev;
      },
      onError: (err, prev) => {
        if (isDevMode()) console.error(err);
        this.posts.set(prev); // rollback on error
      },
      onSuccess: (next) => {
        this.posts.update((posts) => posts.map((p) => (p.id === next.id ? next : p))); // replace with value from server
      },
    },
  );

  createPost(post: Post) {
    this.createPostResource.mutate(post); // send the request
  }
}
```

## In-depth

For an in-depth explanation of the primitives & how they work check out this article: [Fun-grained Reactivity in Angular: Part 3 - Resources](https://dev.to/mihamulec/fun-grained-reactivity-in-angular-part-3-client-side-http-57g4)
