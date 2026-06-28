import { DOCUMENT, isPlatformServer } from '@angular/common';
import { DestroyRef, inject, Injectable, PLATFORM_ID } from '@angular/core';

import { resolveAnnounce, type AnnouncePlugin } from '../provide';

export type Politeness = 'polite' | 'assertive';

/**
 * A single shared ARIA live region for drag-and-drop screen-reader feedback.
 * Call `announce(...)` from your `onReorder` / `onMoveEnd` / delete handlers to
 * narrate keyboard and pointer operations. SSR-safe (no-op on the server).
 *
 * @internal Reach it through {@link injectAnnounce}, not this class.
 */
@Injectable({ providedIn: 'root' })
export class DndAnnouncer {
  private polite: HTMLElement | null = null;
  private assertive: HTMLElement | null = null;

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;
    const doc = inject(DOCUMENT);
    this.polite = this.createRegion(doc, 'polite');
    this.assertive = this.createRegion(doc, 'assertive');
    inject(DestroyRef).onDestroy(() => {
      this.polite?.remove();
      this.assertive?.remove();
    });
  }

  announce(message: string, politeness: Politeness = 'polite'): void {
    const region = politeness === 'assertive' ? this.assertive : this.polite;
    if (!region) return;
    // toggle a zero-width space so identical consecutive messages re-announce
    region.textContent =
      message === region.textContent ? message + '​' : message;
  }

  private createRegion(doc: Document, politeness: Politeness): HTMLElement {
    const el = doc.createElement('div');
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    el.setAttribute(
      'style',
      'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;',
    );
    doc.body.appendChild(el);
    return el;
  }
}

/**
 * Returns the active announce function: a `provideDnd({ plugins: { announce } })`
 * plugin if registered (e.g. Atlassian's live-region), otherwise the built-in
 * `DndAnnouncer`. Injection context only.
 *
 * @example
 * ```ts
 * const announce = injectAnnounce();
 * reorderable(items, {
 *   accepts: isCard, key: (c) => c.id, keyboard: true,
 *   onReorder: ({ item, to }) => announce(`${item.label} moved to position ${to + 1}`),
 * });
 * ```
 */
export function injectAnnounce(override?: AnnouncePlugin): AnnouncePlugin {
  const plugin = resolveAnnounce(override);
  if (plugin) return plugin;
  const announcer = inject(DndAnnouncer);
  return (message, politeness) => announcer.announce(message, politeness);
}
