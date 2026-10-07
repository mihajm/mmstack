import {
  afterNextRender,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  isDevMode,
  runInInjectionContext,
  signal,
} from '@angular/core';

import { surfaceTouchAction } from '../internal/touch-activation';
import { connectNativeContainer, connectNativeItem } from './native';
import { connectPointerContainer, connectPointerItem } from './pointer';
import type {
  ReorderableContainerBinding,
  ReorderableController,
  ReorderableItemBinding,
} from './types';

/**
 * The `touch-action` of a whole-item drag surface. A single linear list drags
 * along its axis only, so the other axis stays free for page panning (`'x'`
 * lists allow `pan-y`, `'y'` lists allow `pan-x`); grouped and wrap lists drag
 * in 2D and get `none`. A touch long-press turns every surface into
 * `manipulation`, since the page may scroll until the press activates.
 */
export function reorderableItemTouchAction(
  controller: Pick<ReorderableController<unknown, unknown>, 'axis' | 'group' | 'touchActivation'>,
): string {
  const linear =
    !controller.group && controller.axis !== 'wrap'
      ? controller.axis === 'x'
        ? 'pan-y'
        : 'pan-x'
      : 'none';
  return surfaceTouchAction(controller.touchActivation, linear);
}

/**
 * Wire a container element up as a sortable list: own the single delegated
 * pointer gesture, drive begin/move/end, run edge auto-scroll, register the
 * container for cross-list bounds, and clean up group membership on destroy.
 * The directive just calls this — no logic of its own. `element` is injected
 * when omitted. Injection context only.
 */
export function connectReorderableContainer<T, K = unknown>(
  controller: () => ReorderableController<T, K>,
  opts?: { element?: HTMLElement },
): ReorderableContainerBinding {
  const element =
    opts?.element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const injector = inject(Injector);
  // Defer: the engine comes from a required input not available at construction.
  afterNextRender(
    () =>
      runInInjectionContext(injector, () => {
        const connected = controller();
        if (connected.engine === 'native')
          connectNativeContainer(controller, element);
        else connectPointerContainer(controller, element);
        if (isDevMode()) {
          let warned = false;
          effect(() => {
            if (controller() !== connected && !warned) {
              warned = true;
              console.warn(
                '[@mmstack/dnd] reorderable: the controller instance changed after the container was wired — gestures/drop targets stay bound to the original. Recreate the container (e.g. @if) to swap controllers.',
              );
            }
          });
        }
      }),
    { injector },
  );
  return { reservedSpace: computed(() => controller().reservedSpace()) };
}

/**
 * Marks the list container. Pure wiring — the gesture, auto-scroll, and
 * cross-list bookkeeping all live in {@link connectReorderableContainer}.
 */
@Directive({
  selector: '[mmReorderable]',
  // reserved space is a CSS var, not an imposed `padding-bottom` (would clobber the consumer's).
  host: { '[style.--mm-sortable-reserved]': "state.reservedSpace() + 'px'" },
})
export class Reorderable<T, K = unknown> {
  readonly controller = input.required<ReorderableController<T, K>>({
    alias: 'mmReorderable',
  });
  protected readonly state = connectReorderableContainer<T, K>(() =>
    this.controller(),
  );
}

/**
 * Hook an element up as a sortable item: register it, derive its per-item state,
 * and own the keyboard-reorder + a11y logic — so the directive is pure wiring.
 * `element` and `parent` are injected when omitted. Injection context only.
 */
export function connectReorderableItem<T, K = unknown>(
  item: () => T,
  opts?: { parent?: Reorderable<T, K>; element?: HTMLElement },
): ReorderableItemBinding<K> {
  const parent = opts?.parent ?? inject<Reorderable<T, K>>(Reorderable);
  const element =
    opts?.element ?? inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const injector = inject(Injector);
  // Defer the per-engine binding: engine isn't known until the input resolves.
  const inner = signal<ReorderableItemBinding<K> | null>(null);
  afterNextRender(
    () =>
      runInInjectionContext(injector, () =>
        inner.set(
          parent.controller().engine === 'native'
            ? connectNativeItem<T, K>(() => parent.controller(), item, element)
            : connectPointerItem<T, K>(
                () => parent.controller(),
                item,
                element,
              ),
        ),
      ),
    { injector },
  );
  return {
    itemKey: computed(() => inner()?.itemKey() as K),
    index: computed(() => inner()?.index() ?? -1),
    isSource: computed(() => inner()?.isSource() ?? false),
    transform: computed(() => inner()?.transform() ?? 0),
    transformX: computed(() => inner()?.transformX() ?? 0),
    transformY: computed(() => inner()?.transformY() ?? 0),
    transformCss: computed(() => inner()?.transformCss() ?? ''),
    transitionCss: computed(() => inner()?.transitionCss() ?? 'none'),
    tabIndex: computed(() => inner()?.tabIndex() ?? null),
    onKeydown: (e) => inner()?.onKeydown(e),
  };
}

/**
 * A thin DOM adapter: one input + one hookup call. By default the whole item is
 * the drag surface and carries the `touch-action` from
 * {@link reorderableItemTouchAction}; add a `[mmReorderableHandle]` child to
 * scope dragging (and the `touch-action`) to just the handle, leaving the body
 * scrollable on touch.
 */
@Directive({
  selector: '[mmReorderableItem]',
  host: {
    'data-mm-reorderable-item': '',
    '[attr.data-mm-reorderable-handle]': 'hasHandle() ? null : ""',
    '[attr.tabindex]': 'state.tabIndex()',
    '[style.touch-action]': 'hasHandle() ? null : surfaceTouchAction()',
    '[style.user-select]': "'none'",
    '[style.position]': "'relative'",
    '[style.transform]': 'state.transformCss()',
    '[style.transition]': 'state.transitionCss()',
    '[style.zIndex]': 'state.isSource() ? 1 : null',
    '[class.mm-sortable-dragging]': 'state.isSource()',
    '(keydown)': 'state.onKeydown($event)',
  },
})
export class ReorderableItem<T, K = unknown> {
  readonly item = input.required<T>({ alias: 'mmReorderableItem' });
  protected readonly state = connectReorderableItem<T, K>(() => this.item());
  private readonly parent = inject<Reorderable<T, K>>(Reorderable);
  protected readonly surfaceTouchAction = computed(() =>
    reorderableItemTouchAction(
      this.parent.controller() as ReorderableController<unknown, unknown>,
    ),
  );
  /** @internal the handle's `touch-action`: `none`, or `manipulation` under a touch long-press. */
  readonly handleTouchAction = computed(() =>
    surfaceTouchAction(this.parent.controller().touchActivation, 'none'),
  );

  protected readonly hasHandle = signal(false);
  registerHandle(): void {
    this.hasHandle.set(true);
  }
  unregisterHandle(): void {
    this.hasHandle.set(false);
  }
}

/**
 * Marks a child of a `[mmReorderableItem]` as the drag handle: only it starts a
 * drag and carries `touch-action: none` (`manipulation` under a touch
 * long-press). Optional: without it the whole item is the handle.
 */
@Directive({
  selector: '[mmReorderableHandle]',
  host: {
    'data-mm-reorderable-handle': '',
    '[style.touch-action]': 'item.handleTouchAction()',
    '[style.cursor]': "'grab'",
  },
})
export class ReorderableHandle {
  protected readonly item = inject(ReorderableItem);
  constructor() {
    this.item.registerHandle();
    inject(DestroyRef).onDestroy(() => this.item.unregisterHandle());
  }
}

export { injectReorderable, reorderable } from './controller';
export {
  injectReorderableDefaults,
  provideReorderableDefaults,
  type ReorderableDefaults,
} from './defaults';
export type {
  ReorderableAnimation,
  ReorderableAxis,
  ReorderableContainerBinding,
  ReorderableController,
  ReorderableItemBinding,
  ReorderableItemState,
  ReorderableOptions,
  ReorderKeyboardApi,
} from './types';
