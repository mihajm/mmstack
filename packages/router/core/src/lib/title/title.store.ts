import {
  computed,
  effect,
  inject,
  Injectable,
  linkedSignal,
  Signal,
  untracked,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ResolveFn } from '@angular/router';
import { mutable, until } from '@mmstack/primitives';
import { injectLeafRoutes, injectSnapshotPathResolver } from '../util';
import { injectTitleConfig } from './title.config';

@Injectable({
  providedIn: 'root',
})
export class TitleStore {
  private readonly title = inject(Title);
  private readonly map = mutable<Map<string, Signal<string>>>(new Map());
  private readonly leafRoutes = injectLeafRoutes();
  private readonly activeLeafPath = computed(
    () => this.leafRoutes().at(-1)?.path,
  );

  constructor() {
    const currentTitleSignal = computed(() => {
      const path = this.activeLeafPath();
      if (!path) return null;
      return this.map().get(path) ?? null;
    });

    const fallback = computed(
      () =>
        this.leafRoutes()
          .toReversed()
          .find((leaf) => leaf.route.title)?.route.title ?? '',
    );

    const currentTitle = computed(() => currentTitleSignal()?.() ?? fallback());

    const heldTitle = injectTitleConfig().keepLastKnown
      ? linkedSignal<string, string>({
          source: () => currentTitle(),
          computation: (value, prev) => {
            if (!value) return prev?.value ?? '';
            return value;
          },
        })
      : currentTitle;

    effect(() => {
      this.title.setTitle(heldTitle());
    });

    effect(() => {
      const activeLeafPath = this.activeLeafPath();
      if (!activeLeafPath) return this.map.inline((cur) => cur.clear());
      this.map.inline((cur) => {
        for (const key of cur.keys()) {
          if (key === activeLeafPath) continue;
          cur.delete(key);
        }
      });
    });
  }

  register(id: string, titleFn: Signal<string>) {
    this.map.inline((m) => m.set(id, titleFn));
  }

  get(id: string) {
    const found = untracked(this.map).get(id);
    return found ? untracked(found) : null;
  }
}

/**
 *
 * Creates a title resolver function that can be used in Angular's router.
 *
 * @param fn
 * A function that returns a string or a Signal<string> representing the title.
 * @param awaitValue
 * If `true`, the resolver will wait until the title signal has a value before resolving.
 * Defaults to `false`.
 */
export function createTitle(
  fn: () => string | (() => string),
  awaitValue = false,
): ResolveFn<string> {
  return async (route): Promise<string> => {
    const store = inject(TitleStore);
    const resolver = injectSnapshotPathResolver();
    const fp = resolver(route);
    const found = store.get(fp);
    if (found) return Promise.resolve(found);

    const { parser } = injectTitleConfig();

    const resolved = fn();

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
