import { Directive, effect, ElementRef, inject, input } from '@angular/core';

/**
 * Per-element morphs on held swaps: assigns `view-transition-name` reactively, so when
 * a swap wrapped in `document.startViewTransition` flips views (`*mmTransition`'s
 * `mmTransitionViewTransition`, or the transition outlet's view-transition option), the
 * browser pairs same-named elements across the outgoing and incoming views and MORPHS
 * them instead of cross-fading the whole boundary.
 *
 * ```html
 * <!-- outgoing view (list) and incoming view (detail) both name the hero image: -->
 * <img [mmViewTransitionName]="'hero-' + item().id" [src]="item().img" />
 * ```
 *
 * Why this works with holds: both views coexist in the DOM during a hold, but the
 * incoming one is `display: none` — elements without boxes aren't captured, so the
 * same name on both sides is legal at each capture point (old visible at snapshot,
 * new visible after the swap). No arming/cleanup dance needed.
 *
 * The name is normalized to a valid CSS custom-ident (invalid characters → `-`, a
 * leading digit gets a `_` prefix). An empty string / `'none'` clears the name — use
 * that to opt an element out conditionally. One rule remains YOURS to keep: a name
 * must be unique among elements VISIBLE at capture time (two rendered instances of the
 * same named element make the browser skip the whole transition) — derive names from
 * ids for anything that can repeat.
 */
@Directive({ selector: '[mmViewTransitionName]' })
export class MmViewTransitionName {
  readonly mmViewTransitionName = input.required<string>();

  constructor() {
    const el = inject(ElementRef).nativeElement as HTMLElement;
    effect(() => {
      const name = normalizeIdent(this.mmViewTransitionName());
      if (name) el.style.setProperty('view-transition-name', name);
      else el.style.removeProperty('view-transition-name');
    });
  }
}

/** @internal `''`/`'none'` clear; otherwise coerce into a valid custom-ident. */
function normalizeIdent(raw: string): string | null {
  if (!raw || raw === 'none') return null;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-');
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}
