// inspired by SolidJS 2.0's Reveal — https://github.com/solidjs/solid
import {
  afterEveryRender,
  booleanAttribute,
  Component,
  effect,
  forwardRef,
  input,
  untracked,
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
 *
 * Boundaries that come from an `@for` can take their order from the data instead: give the reveal
 * the same array and track function (`[items]`, `[track]`, identity by default) and each boundary
 * its row (`[item]`). Order and membership then follow the array, a move is seen at once and
 * nothing is read from the DOM. A boundary whose key is not in `items` (or that has no item) is
 * held and holds nothing; two boundaries with one key order by registration.
 *
 * ```html
 * <mm-reveal [items]="rows()" [track]="byId">
 *   @for (row of rows(); track row.id) {
 *     <mm-suspense [item]="row"><app-row [row]="row" /></mm-suspense>
 *   }
 * </mm-reveal>
 * ```
 */
const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const identity = (item: unknown) => item;

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
  /** The rows the slots come from. An array switches the reveal to data order; `undefined` keeps document order. */
  readonly items = input<readonly unknown[] | undefined>(undefined);
  /** A row's key, the same function the `@for` tracks by. Identity by default. */
  readonly track = input<(item: any) => unknown>(identity);

  private readonly coordinator = createRevealCoordinator({
    order: this.order,
    onError: this.onError,
    collapsed: this.collapsed,
    keyed: { items: this.items, track: (item) => this.track()(item) },
  });

  // hosts of the current slots, one entry per slot (two slots may share a host)
  private readonly hosts = new Map<RevealSlot, RevealHost>();
  private seen: readonly RevealHost[] = [];

  // dev only: mounted slots and their items, for the keyed-mode warnings
  private readonly mountedItems = new Set<(() => unknown) | null>();
  private warnedDuplicate = false;
  private warnedNoItem = false;

  constructor() {
    // placement: hosts that moved, left or rejoined the document with no slot changing
    afterEveryRender(() => this.observe());
    if (typeof ngDevMode !== 'undefined' && ngDevMode) {
      // once per `items` change: duplicate keys, and mounted slots with no item once keyed
      effect(() => {
        const items = this.items();
        if (items === undefined) return;
        const track = this.track();
        if (!this.warnedDuplicate) {
          const keys = new Set<unknown>();
          for (const item of items) {
            const key = track(item);
            if (keys.has(key)) {
              this.warnedDuplicate = true;
              console.warn(
                `[mm-reveal] duplicate key in items: ${String(key)}. Slots sharing a key order by registration.`,
              );
              break;
            }
            keys.add(key);
          }
        }
        untracked(() => this.checkItems());
      });
    }
  }

  register(
    state: () => RevealSlotState,
    host?: RevealHost | null,
    item?: (() => unknown) | null,
  ): RevealSlot {
    const slot = this.coordinator.register(state, host, item);
    if (host) this.hosts.set(slot, host);
    let mount = slot.mount;
    let unmount = () => undefined as void;
    if (typeof ngDevMode !== 'undefined' && ngDevMode) {
      // by mount the boundary's inputs are bound, so its item is real
      mount = () => {
        slot.mount();
        this.mountedItems.add(item ?? null);
        this.checkItems();
      };
      unmount = () => void this.mountedItems.delete(item ?? null);
    }
    return {
      ...slot,
      mount,
      unregister: () => {
        this.hosts.delete(slot);
        unmount();
        slot.unregister();
      },
    };
  }

  relayout(): void {
    this.coordinator.relayout();
  }

  private checkItems() {
    if (this.warnedNoItem || untracked(this.items) === undefined) return;
    for (const item of this.mountedItems)
      if (!item || untracked(item) === undefined) {
        this.warnedNoItem = true;
        console.warn(
          '[mm-reveal] a boundary has no [item] while the reveal has [items]: it is held and holds nothing. Bind [item] on every boundary, or drop [items].',
        );
        return;
      }
  }

  private observe() {
    // keyed: order comes from `items`, there is nothing to read off the page
    if (this.items() !== undefined) return;
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
    this.relayout();
  }
}

declare const ngDevMode: boolean | undefined;
