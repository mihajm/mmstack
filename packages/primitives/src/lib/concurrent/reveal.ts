// inspired by SolidJS 2.0's Reveal — https://github.com/solidjs/solid
import {
  afterEveryRender,
  booleanAttribute,
  Component,
  forwardRef,
  input,
} from '@angular/core';
import {
  createRevealCoordinator,
  REVEAL,
  type RevealCoordinator,
  type RevealHost,
  type RevealOnError,
  type RevealOrder,
  type RevealSlot,
  type RevealSlotState,
} from '@mmstack/primitives/core';

/**
 * Coordinates when its sibling suspense boundaries show their content. Each `<mm-suspense>` (or
 * `<mm-unscoped-suspense>`) inside it with no other boundary in between is a slot, in document
 * order: the order they appear on the page, whether they come from `@if`, `@for` or a plain
 * element, and kept up to date as they move. A boundary nested in a slot belongs to that slot, not
 * to the reveal. A boundary rendered elsewhere (a portal or overlay) orders by where it renders;
 * provide `severReveal()` at the portal host to keep it out.
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
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

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

  // hosts of the current slots, one entry per slot (two slots may share a host)
  private readonly hosts = new Map<RevealSlot, RevealHost>();
  private seen: readonly RevealHost[] = [];

  constructor() {
    // placement: hosts that moved, left or rejoined the document with no slot changing
    afterEveryRender(() => this.observe());
  }

  register(state: () => RevealSlotState, host?: RevealHost | null): RevealSlot {
    const slot = this.coordinator.register(state, host);
    if (!host) return slot;
    this.hosts.set(slot, host);
    return {
      ...slot,
      unregister: () => {
        this.hosts.delete(slot);
        slot.unregister();
      },
    };
  }

  relayout(): void {
    this.coordinator.relayout();
  }

  private observe() {
    const now = [...this.hosts.values()]
      .filter((h) => h.isConnected)
      .sort((a, b) =>
        a === b ? 0 : a.compareDocumentPosition(b) & FOLLOWING ? -1 : 1,
      );
    if (
      now.length === this.seen.length &&
      now.every((h, i) => h === this.seen[i])
    )
      return;
    this.seen = now;
    this.coordinator.relayout();
  }
}
