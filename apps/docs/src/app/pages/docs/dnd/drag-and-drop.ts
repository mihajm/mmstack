import { Component } from '@angular/core';
import { DragDropDemo } from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-drag-and-drop',
  imports: [DocPage, DocSection, CodeExample, DemoBox, DragDropDemo, Link],
  template: `
    <docs-page
      title="Draggables and drop targets"
      pkg="@mmstack/dnd"
      lead="The element layer. mmDraggable carries a typed payload, mmDropTarget narrows it and exposes drag state, and the drop updates your own signal."
    >
      <docs-demo title="Move cards between columns">
        @defer (on viewport) {
          <demo-drag-drop />
        } @placeholder {
          <p class="defer-hint">Demo loads on scroll.</p>
        }
      </docs-demo>

      <docs-section title="Draggable" id="draggable">
        <p>
          Put <code>mmDraggable</code> on an element and give it
          <code>data</code>. That value is the payload a drop target receives.
          Read <code>dragging()</code> from the directive to style the element
          while it moves.
        </p>
        <docs-code [code]="draggableEx" label="template" lang="html" />
      </docs-section>

      <docs-section title="Drop target" id="drop-target">
        <p>
          <code>mmDropTarget</code> takes an <code>accepts</code> guard, a type
          predicate that narrows the payload with no casting. When the guard
          passes, <code>isDragOver()</code> turns true and
          <code>dropped</code> fires with the typed data. The drop hands you the
          payload and you update your own signal, so your data stays the source
          of truth and nothing is mutated mid-drag.
        </p>
        <docs-code [code]="dropEx" label="component" lang="ts" />
      </docs-section>

      <docs-section title="More drop-target state" id="drop-state">
        <p>
          <code>isDragOver()</code> is true while an accepted source hovers the
          target at any depth. For nested targets, <code>isInnermost()</code> is
          true only on the deepest one under the pointer, so an outer region can
          stay quiet while its child lights up. <code>dragOverData()</code> gives
          you the hovering payload, already narrowed by <code>accepts</code>, so
          you can preview the drop before it happens. All three are derived from
          the same session, so reading them costs nothing until it changes.
        </p>
        <docs-code [code]="stateEx" lang="ts" />
        <p>
          Two more inputs shape native drops. <code>sticky</code> keeps the
          target active after the pointer leaves its bounds, and
          <code>dropEffect</code> (<code>'move'</code>, <code>'copy'</code>, or
          <code>'link'</code>) sets the cursor the browser shows. Both are
          native-engine features and are compile-time-forbidden on the pointer
          engine.
        </p>
        <docs-code [code]="stickyEx" label="template" lang="html" />
      </docs-section>

      <docs-section title="Metadata channel" id="meta">
        <p>
          Alongside <code>data</code>, both a draggable and a drop target carry a
          typed <code>meta</code> payload. It is keyed by symbols, so it never
          collides with your own data or with tokens a plugin attaches, and it
          rides the drag separately from the payload. This is the seam the
          higher-level patterns build on: tag a source with the list it came
          from, then gate a drop on that tag in <code>canDrop</code> without
          touching the payload shape.
        </p>
        <docs-code [code]="metaEx" lang="ts" />
      </docs-section>

      <docs-section title="When to use this" id="when">
        <p>
          Reach for the element layer when items move between free-form regions
          and there is no single ordered list to maintain, like a board with
          columns or a trash zone. For an ordered list where position matters,
          <a mmLink="/docs/dnd/reorderable">sortable lists</a> handle the
          reordering and animation for you.
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
export class DragAndDropDoc {
  protected readonly draggableEx = `<article
  mmDraggable
  #d="mmDraggable"
  [data]="card"
  [class.dragging]="d.dragging()"
>
  {{ card.title }}
</article>`;

  protected readonly dropEx = `type Card = { id: number; title: string };

const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

@Component({
  imports: [DropTarget],
  template: \`
    <section
      mmDropTarget
      #zone="mmDropTarget"
      [accepts]="isCard"
      [class.over]="zone.isDragOver()"
      (dropped)="move($event.data)"
    ></section>
  \`,
})
class Column {
  protected readonly isCard = isCard;
  move(card: Card) { /* update your own signal */ }
}`;

  protected readonly stateEx = `protected readonly zone = dropTarget<Card>({ accepts: isCard });
// zone.isDragOver()   any accepted source hovering, at any depth
// zone.isInnermost()  true only on the deepest target under the pointer
// zone.dragOverData() the hovering Card (narrowed), else undefined`;

  protected readonly stickyEx = `<section
  mmDropTarget
  #zone="mmDropTarget"
  [accepts]="isCard"
  [sticky]="true"
  dropEffect="copy"
></section>`;

  protected readonly metaEx = `import { draggable, dropTarget } from '@mmstack/dnd';

const KIND = Symbol('kind');

draggable<Card, { [KIND]: 'todo' | 'done' }>({
  data,
  meta: () => ({ [KIND]: 'todo' }),
});

dropTarget<Card, void, { [KIND]: 'todo' | 'done' }>({
  accepts: isCard,
  // gate on the tag, not the payload:
  canDrop: ({ source: { meta } }) => meta[KIND] === 'todo',
});`;
}
