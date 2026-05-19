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
import { type ResolveFn } from '@angular/router';
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
 *
 * Creates a title resolver function that can be used in Angular's router.
 *
 * @param factoryOrValue
 * A function that returns a string or a Signal<string> representing the title or just the string directly.
 * @param awaitValue
 * If `true`, the resolver will wait until the title signal has a value before resolving.
 * Defaults to `false`.
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
