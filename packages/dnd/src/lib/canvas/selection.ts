import { computed, signal, type Signal } from '@angular/core';

export type SelectionRef<K = unknown> = {
  /** Currently selected keys, in insertion order. */
  ids: Signal<readonly K[]>;
  /** Reactive membership test (use inside a template/computed). */
  has(id: K): boolean;
  /** Reactive count. */
  size: Signal<number>;
  toggle(id: K): void;
  add(id: K): void;
  remove(id: K): void;
  set(ids: readonly K[]): void;
  clear(): void;
};

/**
 * Lightweight multi-select state for canvas items. Pure signals — the canvas
 * controller reads it to decide a gesture's participants; share one instance
 * across surfaces (or with your own chrome) via the `selection` option.
 * `multi: false` keeps a single selection (toggle/add replace).
 */
export function selection<K = unknown>(
  opts: { multi?: boolean } = {},
): SelectionRef<K> {
  const multi = opts.multi ?? true;
  const _ids = signal<readonly K[]>([]);
  const asSet = computed(() => new Set(_ids()));

  const add = (id: K): void => {
    if (asSet().has(id)) return;
    _ids.set(multi ? [..._ids(), id] : [id]);
  };

  const remove = (id: K): void => {
    if (!asSet().has(id)) return;
    _ids.set(_ids().filter((x) => x !== id));
  };

  const toggle = (id: K): void => {
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
