import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  type Signal,
} from '@angular/core';

import type { Edge } from '@mmstack/dnd';

/**
 * A self-positioning insertion line, driven by an `Edge | null`. Styles are
 * **component-encapsulated** — no global `<style>` injection, no `::before`.
 * Overlay it on a positioned (`position: relative`) target:
 *
 * ```html
 * <div mmDropTarget #dt="mmDropTarget" [edges]="['top','bottom']" style="position:relative">
 *   …
 *   <mm-drop-indicator [edge]="dt.closestEdge()" />
 * </div>
 * ```
 *
 * Pass `edgeSource` (a `Signal<Edge|null>`) instead of `edge` to drive it from a
 * signal without a copy-effect (used by `reorderable`).
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
  /** Direct edge input — `[edge]="dt.closestEdge()"`. */
  readonly edge = input<Edge | null>(null);
  /** Signal source — bound programmatically (e.g. by `reorderable`) to avoid a copy-effect. */
  readonly edgeSource = input<Signal<Edge | null> | undefined>(undefined);
  readonly indicated = input(true);
  readonly thickness = input(2);
  readonly gap = input(0);

  protected readonly activeEdge = computed<Edge | null>(() => {
    if (!this.indicated()) return null;
    const src = this.edgeSource();
    return src ? src() : this.edge();
  });

  protected readonly offsetCss = computed(
    () => `${-Math.floor(this.thickness() / 2) - this.gap()}px`,
  );
}
