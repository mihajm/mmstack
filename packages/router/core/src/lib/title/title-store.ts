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
import { injectTitleConfig } from './title-config';

@Injectable({
  providedIn: 'root',
})
export class TitleStore {
  private readonly title = inject(Title);
  private readonly map = mutable<Map<string, Signal<string>>>(new Map());
  private readonly leafRoutes = injectLeafRoutes();

  constructor() {
    const reverseLeaves = computed(() => this.leafRoutes().toReversed());

    const currentResolvedTitles = computed(() => {
      const map = this.map();
      return reverseLeaves()
        .map((leaf) => map.get(leaf.path)?.() ?? leaf.route.title)
        .filter((v): v is string => !!v);
    });

    const currentTitle = computed(() => currentResolvedTitles().at(0) ?? '');

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
  }

  register(id: string, titleFn: Signal<string>) {
    this.map.inline((m) => m.set(id, titleFn));
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
