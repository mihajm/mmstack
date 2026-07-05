import { Component } from '@angular/core';
import { CanvasBoardDemo } from '@mmstack/demos';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-canvas',
  imports: [DocPage, DocSection, CodeExample, DemoBox, CanvasBoardDemo],
  template: `
    <docs-page
      title="Canvas"
      pkg="@mmstack/dnd"
      experimental
      lead="A free-form canvas controller. Move, resize, rotate, marquee-select and snap over an items signal you own. Mid-gesture state is a derived overlay; your signal is written once, at drop, which is exactly the shape stores, undo history and realtime sync want."
    >
      <docs-section title="The controller" id="controller">
        <p>
          <code>canvas()</code> takes your array signal and two pure lenses:
          <code>frame</code> reads an item's position and size (a
          <code>CanvasFrame</code>: <code>x</code>, <code>y</code>,
          <code>width</code>, <code>height</code>, optional
          <code>rotation</code>), <code>patch</code> writes one back
          immutably. One delegated gesture on the surface decides what a press
          means by the element it lands on: an item moves, a handle resizes or
          rotates, empty space starts a marquee.
        </p>
        <docs-demo
          title="Drag, marquee across, click to select, resize by the corners"
        >
          @defer (on viewport) {
            <demo-canvas-board />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="controllerEx" label="component" lang="ts" />
        <p>
          Moves are transform-only, so the browser composites instead of laying
          out, and idle items recompute nothing while others drag. On release
          the controller maps <code>patch</code> over the touched items in one
          write and leaves everything else reference-identical.
        </p>
      </docs-section>

      <docs-section title="Interactions" id="interactions">
        <p>
          The defaults match the tools people already know. Dragging an
          unselected item selects it, Shift-click toggles membership, dragging
          empty space marquee-selects, clicking empty space clears. Shift locks
          a move to the dominant axis and holds the aspect ratio on a resize,
          Alt resizes from the center, Ctrl bypasses snapping, Escape cancels.
          Arrow keys nudge the selection by the grid step, Shift makes it ten
          steps, and Cmd or Ctrl with an arrow resizes. Alignment snaplines and
          grid snap resolve from boxes measured once at gesture start, so
          mid-drag layout can never feed back into its own collision.
        </p>
      </docs-section>

      <docs-section title="Chrome from signals" id="chrome">
        <p>
          The canvas is headless: selection outlines, handles, snaplines and
          the marquee rectangle are yours to render.
          <code>ctrl.session</code> exposes the derivation core
          (<code>guides</code>, <code>marqueeRect</code>,
          <code>hoverContainer</code>, the live deltas), the item directive
          sets <code>mm-canvas-selected</code> and
          <code>mm-canvas-dragging</code> classes, and the handle directives
          just mark elements with data attributes the gesture arbitration
          reads. The demo's snaplines are one SVG with a loop over
          <code>guides()</code>.
        </p>
        <docs-code [code]="chromeEx" label="template" lang="ts" />
      </docs-section>

      <docs-section title="Pan and zoom" id="pan-zoom">
        <p>
          <code>panZoom()</code> owns a space transform (wheel zooms around the
          cursor, middle-button drag pans) and doubles as the canvas
          <code>space</code> option, so every gesture projects through the live
          transform. You can zoom in the middle of a drag and the grabbed point
          stays under the cursor; snap tolerances stay screen-accurate at any
          scale.
        </p>
        <docs-code [code]="panZoomEx" lang="ts" />
      </docs-section>

      <docs-section title="Containment" id="containment">
        <p>
          For editors where items contain other items, stages in a workflow,
          sections on a page, the <code>containers</code> option resolves the
          innermost accepting container under the pointer while you drag and
          reports it on the commit. With <code>containerOf</code> a drop over a
          different container becomes a reparent: the controller hands you
          frames already rebased into the target's coordinate space and does
          not write, so your tree restructuring and the frame updates land in
          a single update.
        </p>
        <docs-code [code]="containersEx" lang="ts" />
      </docs-section>

      <docs-section title="Stores, undo, multiplayer" id="stores">
        <p>
          One identity-preserving write per gesture is what makes the canvas
          compose with <code>&#64;mmstack/primitives</code> stores without any
          coupling: an op log sees a whole drag as one batch of per-property
          ops, <code>storeHistory</code> undoes it as one step, and per-property
          ops merge cleanly across peers. For live collaboration,
          <code>ctrl.liveFrames()</code> is the in-flight frames of the current
          gesture (throttle it into your presence channel), incoming peer drags
          render through the <code>remoteOverlays</code> option, and
          <code>lockedKeys</code> rejects local gestures on peer-held items.
        </p>
        <docs-code [code]="storeEx" lang="ts" />
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
export class DndCanvasDoc {
  protected readonly controllerEx = `import { Canvas, CanvasItem, CanvasResizeHandle, injectCanvas, type CanvasFrame } from '@mmstack/dnd';

type Widget = { id: string; frame: CanvasFrame };

@Component({
  imports: [Canvas, CanvasItem, CanvasResizeHandle],
  template: \`
    <div class="board" [mmCanvas]="ctrl">
      @for (w of ctrl.items(); track w.id) {
        <div class="widget" [mmCanvasItem]="w">
          @if (solo() === w.id) {
            <!-- resize acts on a single selected item -->
            <i class="handle" mmCanvasResizeHandle="se"></i>
          }
        </div>
      }
    </div>
  \`,
})
class Board {
  private readonly widgets = signal<readonly Widget[]>([...]);
  protected readonly ctrl = injectCanvas(this.widgets, {
    key: (w) => w.id,
    frame: (w) => w.frame,
    patch: (w, frame) => ({ ...w, frame }),
    grid: { size: 8 },
  });
  protected readonly solo = computed(() => {
    const ids = this.ctrl.selection.ids();
    return ids.length === 1 ? ids[0] : null;
  });
}`;

  protected readonly chromeEx = `<svg class="overlay">
  @for (g of ctrl.session.guides(); track $index) {
    <line class="guide" [attr.x1]="..." [attr.y1]="..." />
  }
  @if (ctrl.session.marqueeRect(); as r) {
    <rect class="marquee" [attr.x]="r.x" [attr.y]="r.y" ... />
  }
</svg>`;

  protected readonly panZoomEx = `protected readonly zoom = panZoom(this.viewportRef);
protected readonly ctrl = injectCanvas(this.widgets, {
  // ...lenses
  space: this.zoom,
});

// apply the transform to your content layer:
// [style.transform]="'translate(' + t.x + 'px, ' + t.y + 'px) scale(' + t.scale + ')'"`;

  protected readonly containersEx = `injectCanvas(this.nodes, {
  // ...lenses
  containers: {
    isContainer: (n) => n.kind === 'stage',
    containerOf: (n) => n.parent,
    canContain: (stage, item) => item.kind === 'task',
  },
  onReparent: ({ patches, container }) => {
    this.nodes.update((arr) =>
      arr.map((n) => {
        const frame = patches.get(n.id);
        return frame ? { ...n, frame, parent: container } : n;
      }),
    );
  },
});`;

  protected readonly storeEx = `import { opLog, store, storeHistory } from '@mmstack/primitives';

const doc = store<{ widgets: Widget[] }>({ widgets: [...] });
const history = storeHistory(doc);
const ctrl = injectCanvas(doc.widgets, { key, frame, patch });

// a whole drag emits ONE batch:
//   set widgets.3.frame.x, set widgets.3.frame.y
opLog(doc, { origin: clientId }).subscribe(sendToPeers);
history.undo(); // restores the whole gesture`;
}
