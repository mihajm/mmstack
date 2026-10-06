// inspired by SolidJS 2.0's Reveal — https://github.com/solidjs/solid
import { booleanAttribute, Component, forwardRef, input } from '@angular/core';
import {
  createRevealCoordinator,
  REVEAL,
  type RevealCoordinator,
  type RevealOnError,
  type RevealOrder,
  type RevealSlot,
  type RevealSlotState,
} from '@mmstack/primitives/core';

/**
 * Coordinates when its sibling suspense boundaries show their content. Each `<mm-suspense>` (or
 * `<mm-unscoped-suspense>`) inside it with no other boundary in between is a slot, ordered by
 * creation. A boundary nested in a slot belongs to that slot, not to the reveal.
 *
 * - `order="forwards"` (the default): a slot shows its content once it is ready and every slot
 *   before it has been shown. `"backwards"` is the mirror. `"together"`: all slots show at once
 *   when every slot is ready.
 * - `onError="settled"` (the default): a failed slot shows its error and the slots after it go on.
 *   `"blocks"`: a failed slot shows its error and holds the others until a retry succeeds.
 * - A slot held back by another slot shows its placeholder; with `collapsed` it renders nothing,
 *   so only the next slot in line shows a placeholder.
 *
 * A slot that has been shown stays shown, even if it suspends again (its boundary then shows its
 * own placeholder or busy state). Reveal schedules display only: content inside a held slot is
 * created and loads as usual.
 *
 * ```html
 * <mm-reveal order="forwards" collapsed>
 *   <mm-suspense><app-profile /></mm-suspense>
 *   <mm-suspense><app-feed /></mm-suspense>
 * </mm-reveal>
 * ```
 */
@Component({
  selector: 'mm-reveal',
  template: '<ng-content />',
  styles: ':host { display: contents; }',
  providers: [{ provide: REVEAL, useExisting: forwardRef(() => MmReveal) }],
})
export class MmReveal implements RevealCoordinator {
  readonly order = input<RevealOrder>('forwards');
  readonly onError = input<RevealOnError>('settled');
  readonly collapsed = input(false, { transform: booleanAttribute });

  private readonly coordinator = createRevealCoordinator({
    order: this.order,
    onError: this.onError,
    collapsed: this.collapsed,
  });

  register(state: () => RevealSlotState): RevealSlot {
    return this.coordinator.register(state);
  }
}
