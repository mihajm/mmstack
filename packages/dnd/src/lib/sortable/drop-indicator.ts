import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import type { Edge } from '../internal/types';

/**
 * A self-positioning insertion line, driven by an `Edge | null`. Styles are
 * component-encapsulated (no global `<style>`, no `::before`). Overlay it on a
 * positioned (`position: relative`) target — it fills the target (`inset: 0`,
 * `pointer-events: none`) and draws a line on the indicated edge.
 *
 * The indicator render for `engine: 'native'` sortable: items stay put and this
 * line shows where the drop will land (vs the pointer engine's FLIP glide).
 *
 * @example
 * ```html
 * <li mmDropTarget #dt="mmDropTarget" [edges]="['top','bottom']" style="position:relative">
 *   …
 *   <mm-drop-indicator [edge]="dt.closestEdge()" />
 * </li>
 * ```
 * Driven programmatically (e.g. `reorderable`'s native render) via
 * `inputBinding('edge', edgeSignal)` — reactive, no copy-effect.
 */
@Component({
  selector: 'mm-drop-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (activeEdge(); as edge) {
      <div class="line" [attr.data-edge]="edge"></div>
    }
  `,
  host: {
    style:
      'display:block;position:absolute;inset:0;pointer-events:none;z-index:1;',
    '[style.--mm-dnd-thickness]': "thickness() + 'px'",
    '[style.--mm-dnd-offset]': 'offsetCss()',
  },
  styles: `
    .line {
      position: absolute;
      background: var(--mm-drop-indicator-color, #2563eb);
      border-radius: 1px;
    }
    .line[data-edge='top'] {
      top: var(--mm-dnd-offset); left: 0; right: 0; height: var(--mm-dnd-thickness);
    }
    .line[data-edge='bottom'] {
      bottom: var(--mm-dnd-offset); left: 0; right: 0; height: var(--mm-dnd-thickness);
    }
    .line[data-edge='left'] {
      left: var(--mm-dnd-offset); top: 0; bottom: 0; width: var(--mm-dnd-thickness);
    }
    .line[data-edge='right'] {
      right: var(--mm-dnd-offset); top: 0; bottom: 0; width: var(--mm-dnd-thickness);
    }
  `,
})
export class DropIndicator {
  /** The edge to draw the line on (bind a signal via `inputBinding('edge', sig)`). */
  readonly edge = input<Edge | null>(null);
  /** Master switch — `false` hides the line regardless of `edge`. @default true */
  readonly indicated = input(true);
  /** Line thickness in px. @default 2 */
  readonly thickness = input(2);
  /** Extra px to pull the line off the edge (to center it in an inter-item gap). @default 0 */
  readonly gap = input(0);

  protected readonly activeEdge = computed<Edge | null>(() =>
    this.indicated() ? this.edge() : null,
  );

  protected readonly offsetCss = computed(
    () => `${-Math.floor(this.thickness() / 2) - this.gap()}px`,
  );
}
