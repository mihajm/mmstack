import { Component } from '@angular/core';
import { PlacementGridDemo, WrapGridDemo } from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-grids',
  imports: [
    DocPage,
    DocSection,
    CodeExample,
    DemoBox,
    WrapGridDemo,
    PlacementGridDemo,
    Link,
  ],
  template: `
    <docs-page
      title="Grids"
      pkg="@mmstack/dnd"
      experimental
      lead="Two kinds of grid. A wrapping gallery is still a sortable list, so it stays on reorderable with axis: 'wrap'. A dashboard where items own cells and spans is placementGrid, which previews the whole reflow as derivation and writes your signal once, at drop."
    >
      <docs-section title="Wrap grids" id="wrap">
        <p>
          Set <code>axis: 'wrap'</code> and the pointer engine switches to a 2D
          collision model: item centers measured at drag start become fixed
          slots, the dragged tile resolves to the nearest slot, and displaced
          siblings glide to their new slot even across row boundaries. Same
          controller, same directives, same single splice at drop.
        </p>
        <docs-demo title="Drag a tile anywhere">
          @defer (on viewport) {
            <demo-wrap-grid />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="wrapEx" lang="ts" />
        <p>
          Keyboard follows the geometry: Left and Right step the reading order,
          Up and Down move to the nearest tile in the adjacent row. Wrap lists
          join a <code>sortableGroup</code> like any other list, so rows drag
          from a vertical tray into the grid and back. The slot model is exact
          for uniform tiles and a good approximation for mixed sizes, the same
          trade dnd-kit's rect sorting strategy makes. Wrap is pointer-engine
          territory; combining it with the native indicator engine falls back
          to vertical behaviour with a dev warning.
        </p>
      </docs-section>

      <docs-section title="The placement grid" id="placement">
        <p>
          <code>placementGrid</code> is the dashboard model: items carry a cell
          rect (<code>x</code>, <code>y</code>, <code>w</code>, <code>h</code>
          in grid cells) on a fixed column count, and you own the array signal.
          Dragging projects the pointer to a cell and previews the reflow as
          pure derivation. Nothing touches your signal until the drop, which
          commits in one write with untouched items reference-identical.
          Resize by the corner grip; arrows move a focused widget one cell and
          Shift with an arrow resizes it.
        </p>
        <docs-demo title="Drag to reflow, resize by the grip">
          @defer (on viewport) {
            <demo-placement-grid />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="placementEx" label="component" lang="ts" />
        <p>
          The projection only fires when the pointer crosses a cell, so wiggling
          inside one recomputes nothing. The container directive sizes itself to
          the preview rows and exposes the live cell units, which is how the
          demo draws the drop-target outline you see while dragging.
        </p>
        <docs-code [code]="targetEx" label="drop-target chrome" lang="ts" />
      </docs-section>

      <docs-section title="Two compaction modes" id="compaction">
        <p>
          <code>compact: 'vertical'</code> is the default: colliding widgets
          push down to make room and gravity pulls everything up on commit, the
          feel you know from dashboard builders. <code>compact: 'none'</code> is
          the form-builder personality: nothing else moves, a cell is either
          free or the move is rejected, and the projection sticks to the last
          valid cell. During a drag the grid grows by the dragged item's height
          so a drop below the last row is always reachable and every affordance
          stays inside the border.
        </p>
        <docs-code [code]="maskEx" lang="ts" />
        <p>
          <code>targetMask()</code> exposes the validity mask while dragging
          (<code>mask[y * cols + x]</code>), so free cells can light up, and a
          <code>canPlace</code> predicate layers your own placement rules on
          top of the built-in overlap check.
        </p>
      </docs-section>

      <docs-section title="Grids in a group" id="group">
        <p>
          A placement grid is a <code>sortableGroup</code> member. Put it in
          the same group as a palette or tray list and cards drop onto the grid
          at the pointed cell, while widgets dragged out of the grid become
          list rows. Two knobs tune the crossing: the grid exposes
          <code>crossTarget()</code>, true while its drag hovers another
          member, so you can restyle the dragged widget into a preview of the
          row it will become; and the list can set <code>insertSize</code> so
          the gap it opens matches that compact row instead of the widget's
          full grid size.
        </p>
        <docs-code [code]="groupEx" lang="ts" />
        <p>
          The playground's placement grid page has the full version of this,
          morph and all. For the drag-and-drop fundamentals underneath, see
          <a mmLink="/docs/dnd/reorderable">sortable lists</a>.
        </p>
      </docs-section>
    </docs-page>
  `,
  styles: `
    .defer-hint {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin: 0;
    }
  `,
})
export class DndGridsDoc {
  protected readonly wrapEx = `import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

protected readonly gallery = reorderable(this.tiles, {
  engine: 'pointer',
  key: (t) => t.id,
  axis: 'wrap',
});`;

  protected readonly placementEx = `import {
  PlacementGrid,
  PlacementGridItem,
  PlacementGridResizeHandle,
  placementGrid,
  type GridPlacement,
} from '@mmstack/dnd';

type Widget = GridPlacement & { id: string; label: string };

@Component({
  imports: [PlacementGrid, PlacementGridItem, PlacementGridResizeHandle],
  template: \`
    <div [mmPlacementGrid]="grid">
      @for (w of grid.items(); track w.id) {
        <div class="widget" [mmPlacementGridItem]="w">
          {{ w.label }}
          <i class="grip" mmPlacementGridResizeHandle="se"></i>
        </div>
      }
    </div>
  \`,
})
class Dashboard {
  private readonly widgets = signal<Widget[]>([
    { id: 'chart', label: 'Chart', x: 0, y: 0, w: 4, h: 2 },
    { id: 'kpis', label: 'KPIs', x: 4, y: 0, w: 2, h: 1 },
  ]);
  protected readonly grid = placementGrid(this.widgets, {
    key: (w) => w.id,
    cols: 6,
    gap: 8,
    rowHeight: 52,
  });
}`;

  protected readonly targetEx = `<!-- #gridRef="mmPlacementGrid" exposes the live cell units -->
@if (target(); as cell) {
  <i
    class="target"
    [style.transform]="'translate(' + cell.x * (gridRef.units.unitX() + 8) + 'px, ...'"
    [style.width.px]="cell.w * gridRef.units.unitX() + (cell.w - 1) * 8"
  ></i>
}

// component: the projected cell plus the active item's spans
target() {
  const key = this.grid.activeKey();
  const cell = this.grid.projectedCell();
  const item = this.grid.previewLayout().find((w) => w.id === key);
  return key !== null && cell && item
    ? { x: cell.x, y: cell.y, w: item.w, h: item.h }
    : null;
}`;

  protected readonly maskEx = `placementGrid(this.slots, {
  key: (w) => w.id,
  cols: 8,
  compact: 'none',
  canPlace: (item, x, y) => x !== 7, // your rules on top of the overlap check
});

// while dragging: grid.targetMask() is a Uint8Array of valid origins`;

  protected readonly groupEx = `const group = sortableGroup<Widget>();

const grid = placementGrid(this.widgets, { key, cols: 12, group });
const tray = reorderable(this.trayItems, {
  key,
  engine: 'pointer',
  group,
  insertSize: 50, // arrivals open a row-sized gap, not a widget-sized one
});

// template: morph the dragged widget while it hovers the tray
// [class.as-row]="grid.crossTarget() && grid.activeKey() === w.id"`;
}
