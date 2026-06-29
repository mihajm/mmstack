import { computed, signal, type Signal } from '@angular/core';

export type SelectionRef<T = unknown> = {
  /** Currently selected ids, in insertion order. */
  ids: Signal<readonly T[]>;
  /** Reactive membership test (use inside a template/computed). */
  has(id: T): boolean;
  /** Reactive count. */
  size: Signal<number>;
  toggle(id: T): void;
  add(id: T): void;
  remove(id: T): void;
  set(ids: readonly T[]): void;
  clear(): void;
};

/**
 * Lightweight multi-select state for canvas widgets. Pure signals — group-move
 * is `movable` reading `selection.ids()`. `multi: false` keeps a single
 * selection (toggle/add replace).
 */
export function selection<T = unknown>(
  opts: { multi?: boolean } = {},
): SelectionRef<T> {
  const multi = opts.multi ?? true;
  const _ids = signal<readonly T[]>([]);
  const asSet = computed(() => new Set(_ids()));

  const add = (id: T): void => {
    if (asSet().has(id)) return;
    _ids.set(multi ? [..._ids(), id] : [id]);
  };

  const remove = (id: T): void => {
    if (!asSet().has(id)) return;
    _ids.set(_ids().filter((x) => x !== id));
  };

  const toggle = (id: T): void => {
    if (asSet().has(id)) remove(id);
    else add(id);
  };

  return {
    ids: _ids.asReadonly(),
    has: (id) => asSet().has(id),
    size: computed(() => _ids().length),
    toggle,
    add,
    remove,
    set: (ids) => _ids.set(multi ? [...ids] : ids.slice(0, 1)),
    clear: () => _ids.set([]),
  };
}
