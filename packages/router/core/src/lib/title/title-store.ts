import {
  computed,
  effect,
  inject,
  Injectable,
  linkedSignal,
  untracked,
  type Signal,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ResolveFn } from '@angular/router';
import { mutable, until } from '@mmstack/primitives';
import { injectLeafRoutes, injectSnapshotPathResolver } from '../util';
import { injectTitleConfig } from './title-config';

@Injectable({
  providedIn: 'root',
})
export class TitleStore {
  private readonly map = mutable<Map<string, Signal<string>>>(new Map());

  constructor() {
    const { keepLastKnown, initialTitle } = injectTitleConfig();
    const leafRoutes = injectLeafRoutes();
    const title = inject(Title);
    const fallbackTitle = initialTitle || untracked(() => title.getTitle());

    const reverseLeaves = computed(() => leafRoutes().toReversed());

    const currentResolvedTitles = computed(() => {
      const map = this.map();
      return reverseLeaves()
        .map((leaf) => map.get(leaf.path)?.() ?? leaf.route.title ?? null)
        .filter((v) => v !== null);
    });

    const currentTitle = computed(() => currentResolvedTitles().at(0) ?? '');

    const heldTitle = keepLastKnown
      ? linkedSignal<string, string>({
          source: () => currentTitle(),
          computation: (value, prev) => {
            if (!value) return prev?.value ?? '';
            return value;
          },
        })
      : currentTitle;

    effect(() => {
      title.setTitle(heldTitle() || fallbackTitle);
    });
  }

  register(id: string, titleFn: Signal<string>) {
    this.map.inline((m) => m.set(id, titleFn));
  }
}

/**
 * Creates an Angular router `ResolveFn<string>` that registers a title for the
 * route it's attached to. Titles can be static strings, factory functions
 * (called in an injection context, so they can use `inject()`), or signal
 * factories (for reactive titles that change when underlying data does).
 *
 * The resolved title flows through any `prefix` configured via
 * {@link provideTitleConfig}, and is wired into Angular's `Title` service
 * via an effect. Nested routes pick the most-specific leaf's title; if a
 * deeper route has no title and `keepLastKnownTitle` is `true` (default),
 * the previous title is preserved.
 *
 * @param factoryOrValue Either a literal string title, a `() => string`
 *   factory, or a `() => Signal<string>` factory for reactive titles. Factory
 *   callbacks run inside an injection context, so they can use `inject()`.
 * @param awaitValue When `true`, the resolver waits until the title signal
 *   emits a truthy value before resolving — useful for SSR/SEO where the
 *   resolved title should not be empty. Defaults to `false`.
 * @returns An Angular `ResolveFn<string>` to wire into a route's `title` field
 *   (or any other `resolve` slot — the return value isn't usually consumed).
 *
 * @example
 * ```ts
 * // Static title
 * { path: 'about', component: AboutComponent, title: createTitle('About us') }
 *
 * // Factory using inject()
 * {
 *   path: 'users/:id',
 *   component: UserComponent,
 *   title: createTitle(() => inject(ActivatedRoute).snapshot.params['id']),
 * }
 *
 * // Reactive title from a signal store
 * {
 *   path: 'dashboard',
 *   component: DashboardComponent,
 *   title: createTitle(() => {
 *     const user = inject(UserStore).current;
 *     return computed(() => `Dashboard – ${user()?.name ?? 'Guest'}`);
 *   }),
 * }
 * ```
 */
export function createTitle(
  factoryOrValue: (() => string | (() => string)) | string,
  awaitValue = false,
): ResolveFn<string> {
  const factory =
    typeof factoryOrValue === 'string' ? () => factoryOrValue : factoryOrValue;

  return async (route): Promise<string> => {
    const store = inject(TitleStore);
    const resolver = injectSnapshotPathResolver();
    const fp = resolver(route);

    const { parser } = injectTitleConfig();

    const resolved = factory();

    const titleSignal =
      typeof resolved === 'string'
        ? computed(() => resolved)
        : computed(resolved);

    const parsedTitleSignal = computed(() => parser(titleSignal()));

    store.register(fp, parsedTitleSignal);

    if (awaitValue) await until(parsedTitleSignal, (v) => !!v);

    return Promise.resolve(untracked(parsedTitleSignal));
  };
}
