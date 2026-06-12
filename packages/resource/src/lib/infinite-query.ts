import { type HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import {
  queryResource,
  type PAUSED,
  type QueryResourceOptions,
  type QueryResourceRef,
  type RequestContext,
} from './query-resource';

/**
 * Context passed to an infinite query's request fn: the {@link RequestContext}
 * (so the fn can return `ctx.paused` to pause the resource, exactly like
 * `queryResource`) plus the `pageParam` addressing the page to load.
 */
export type InfiniteRequestContext<TPageParam> = RequestContext & {
  pageParam: TPageParam;
};

/**
 * Options for {@link infiniteQueryResource}. Extends {@link QueryResourceOptions}
 * (minus `defaultValue` — the aggregate value is always the `pages` array) with the
 * pagination contract.
 */
export type InfiniteQueryResourceOptions<
  TPage,
  TRaw = TPage,
  TPageParam = unknown,
> = Omit<QueryResourceOptions<TPage, TRaw>, 'defaultValue'> & {
  /** The page param the FIRST page is requested with (e.g. `0`, `1`, or a cursor seed). */
  initialPageParam: TPageParam;
  /**
   * Derives the NEXT page's param from the freshly loaded page (and all pages so far).
   * Return `null`/`undefined` to signal "no more pages" — `hasNextPage` flips false
   * and `fetchNextPage()` becomes a no-op.
   *
   * @example
   * // cursor-based
   * getNextPageParam: (last) => last.nextCursor;
   * // offset-based
   * getNextPageParam: (last, all) => (last.items.length < PAGE_SIZE ? null : all.length);
   */
  getNextPageParam: (
    lastPage: NoInfer<TPage>,
    allPages: NoInfer<TPage>[],
  ) => TPageParam | null | undefined;
};

/**
 * A paginated query resource. `pages` accumulates every loaded page in order;
 * `fetchNextPage()` loads the next one (no-op while one is in flight or when
 * exhausted). Inherits the underlying query's `status`/`error`/`isLoading` and
 * its features (cache, retry, circuit breaker, refresh).
 */
export type InfiniteQueryResourceRef<TPage> = {
  /** Every page loaded so far, in load order. */
  pages: Signal<TPage[]>;
  /** `true` once the first page is in and `getNextPageParam` keeps producing params. */
  hasNextPage: Signal<boolean>;
  /** `true` while a page request beyond the first is in flight. */
  isFetchingNextPage: Signal<boolean>;
  /** The underlying query's loading state (first page + subsequent pages). */
  isLoading: Signal<boolean>;
  status: QueryResourceRef<TPage | undefined>['status'];
  error: QueryResourceRef<TPage | undefined>['error'];
  /** Loads the next page. No-op while loading or when `hasNextPage()` is false. */
  fetchNextPage: () => void;
  /** Reloads the CURRENT page param — the freshly loaded page replaces its slot. */
  reload: () => boolean;
  /** Drops all pages and refetches from `initialPageParam`. */
  reset: () => void;
  destroy: () => void;
};

/**
 * Creates a paginated HTTP resource over {@link queryResource}: one page request at a
 * time, accumulated into a `pages` signal — cursor- and offset-based pagination both
 * fit through `getNextPageParam`. Each page request inherits the full queryResource
 * feature set (caching per page, retries, circuit breaker, refresh triggers).
 *
 * @example
 * ```ts
 * const posts = infiniteQueryResource<PostPage, PostPage, number>(
 *   ({ pageParam }) => ({ url: '/api/posts', params: { page: pageParam } }),
 *   {
 *     initialPageParam: 0,
 *     getNextPageParam: (last, all) => (last.items.length < 20 ? null : all.length),
 *     cache: true,
 *   },
 * );
 *
 * // template:
 * // @for (page of posts.pages(); track $index) { ... }
 * // <button (click)="posts.fetchNextPage()" [disabled]="!posts.hasNextPage()">More</button>
 * const flat = computed(() => posts.pages().flatMap((p) => p.items));
 * ```
 */
export function infiniteQueryResource<
  TPage,
  TRaw = TPage,
  TPageParam = unknown,
>(
  request: (
    ctx: InfiniteRequestContext<TPageParam>,
  ) => HttpResourceRequest | string | undefined | typeof PAUSED,
  options: InfiniteQueryResourceOptions<TPage, TRaw, TPageParam>,
): InfiniteQueryResourceRef<TPage> {
  const { initialPageParam, getNextPageParam, ...rest } = options;
  const injector = options.injector ?? inject(Injector);

  const pageParam = signal<TPageParam>(initialPageParam);
  // pages keyed by the param that produced them, so a reload of an already-loaded
  // page REPLACES its slot instead of appending a duplicate
  const loaded = signal<{ param: TPageParam; page: TPage }[]>([]);

  const resource = queryResource<TPage, TRaw>(
    // forward queryResource's own context so the fn can return ctx.paused —
    // pausing holds the loaded pages and stops page fetches until unpaused
    (qctx) => request({ ...qctx, pageParam: pageParam() }),
    { ...rest, injector } as QueryResourceOptions<TPage, TRaw>,
  );

  const appendRef = effect(
    () => {
      if (resource.status() !== 'resolved') return;
      const page = resource.value();
      if (page === undefined) return;

      untracked(() => {
        const param = pageParam();
        loaded.update((list) => {
          const idx = list.findIndex((e) => Object.is(e.param, param));
          if (idx >= 0) {
            const copy = [...list];
            copy[idx] = { param, page };
            return copy;
          }
          return [...list, { param, page }];
        });
      });
    },
    { injector },
  );

  const pages = computed(() => loaded().map((e) => e.page));

  const nextPageParam = computed(() => {
    const all = pages();
    if (all.length === 0) return null;
    return getNextPageParam(all[all.length - 1], all) ?? null;
  });

  const hasNextPage = computed(() => nextPageParam() !== null);

  const fetchNextPage = () => {
    if (untracked(resource.isLoading)) return; // one page at a time
    const next = untracked(nextPageParam);
    if (next === null) return;
    pageParam.set(next);
  };

  const reset = () => {
    loaded.set([]);
    if (Object.is(untracked(pageParam), initialPageParam)) {
      resource.reload(); // param unchanged — force the refetch
    } else {
      pageParam.set(initialPageParam);
    }
  };

  return {
    pages,
    hasNextPage,
    isFetchingNextPage: computed(
      () => resource.isLoading() && loaded().length > 0,
    ),
    isLoading: resource.isLoading,
    status: resource.status,
    error: resource.error,
    fetchNextPage,
    reload: () => resource.reload(),
    reset,
    destroy: () => {
      appendRef.destroy();
      resource.destroy();
    },
  };
}
