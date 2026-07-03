import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Drag and drop"
      pkg="@mmstack/dnd"
      lead="Drag and drop that reads as signals and drops a single splice into your own array. Make any element draggable with a typed payload, or build a sortable list on a native HTML5 engine or a pointer engine with FLIP, where siblings glide aside to open the gap and there is no browser drag image to fight."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        <code>&#64;atlaskit/pragmatic-drag-and-drop</code> is a peer dependency.
        It powers the native engine and the shared monitor.
      </p>

      <docs-section title="Two engines" id="engines">
        <p>
          The <strong>native</strong> engine uses the browser's HTML5 drag and
          drop, so it handles files, dragging across windows, and the browser
          drag image. The <strong>pointer</strong> engine uses pointer events
          with FLIP animation, so siblings glide aside to open a gap and there
          is no browser drag image to fight.
        </p>
        <p>
          Both feed one session, so the state signals read the same either way.
          Set an engine per element, or set a default once with
          <code>provideDnd</code>.
        </p>
      </docs-section>

      <docs-section title="Setup" id="setup">
        <p>
          The primitives work with no configuration. Provide plugins when you
          want edge detection or auto-scroll. The zero-dependency plugins live
          in the <code>&#64;mmstack/dnd/plugins</code> entry point.
        </p>
        <docs-code [code]="setup" lang="ts" />
        <p>
          A missing plugin degrades to a no-op with a dev warning rather than
          throwing.
        </p>
      </docs-section>

      <docs-section title="Two layers" id="layers">
        <p>
          The element layer is <code>draggable</code> and
          <code>dropTarget</code> (directives <code>mmDraggable</code> and
          <code>mmDropTarget</code>). Use it for free-form drag and drop, like
          moving cards between columns.
        </p>
        <p>
          The sortable layer is <code>reorderable</code> plus a
          <code>sortableGroup</code> for cross-list moves. Use it for ordered
          lists, including nested and cross-list cases.
        </p>
        <ul>
          <li>
            <a mmLink="/docs/dnd/elements">Draggables and drop targets</a>
          </li>
          <li><a mmLink="/docs/dnd/reorderable">Sortable lists</a></li>
        </ul>
      </docs-section>
    </docs-page>
  `,
})
export class DndOverview {
  protected readonly install =
    'npm install @mmstack/dnd @atlaskit/pragmatic-drag-and-drop';

  protected readonly setup = `import { provideDnd } from '@mmstack/dnd';
import { edgeAutoScroll } from '@mmstack/dnd/plugins';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

export const appConfig = {
  providers: [
    provideDnd({
      plugins: {
        hitbox: { attachClosestEdge, extractClosestEdge },
        autoScroll: edgeAutoScroll,
      },
    }),
  ],
};`;
}
