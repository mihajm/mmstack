import { Component } from '@angular/core';
import {
  SortableBoardDemo,
  SortableHorizontalDemo,
  SortableListDemo,
  SortableNestedDemo,
} from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-reorderable',
  imports: [
    DocPage,
    DocSection,
    CodeExample,
    DemoBox,
    SortableListDemo,
    SortableBoardDemo,
    SortableNestedDemo,
    SortableHorizontalDemo,
    Link,
  ],
  template: `
    <docs-page
      title="Sortable lists"
      pkg="@mmstack/dnd"
      lead="reorderable() turns a WritableSignal<T[]> into a sortable list. One controller covers handles, cross-list moves, nesting, and both axes."
    >
      <docs-section title="A single list" id="single">
        <p>
          Call <code>reorderable</code> with your array signal and a
          <code>key</code>. Bind it with <code>mmReorderable</code> on the
          container and <code>mmReorderableItem</code> on each row. The
          <code>engine: 'pointer'</code> option gives you the FLIP animation.
          Reordering is one splice on your signal at drop.
        </p>
        <docs-demo title="Drag a row (grip handle)">
          @defer (on viewport) {
            <demo-sortable-list />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="listEx" label="component" lang="ts" />
        <p>
          Add <code>mmReorderableHandle</code> to an element inside a row to
          restrict the grab area, which keeps the rest of the row scrollable on
          touch.
        </p>
      </docs-section>

      <docs-section title="Between lists" id="cross-list">
        <p>
          Share one <code>sortableGroup&lt;T&gt;()</code> across two lists and
          items drag between them. Each list still owns its own signal.
        </p>
        <docs-demo title="Drag between columns">
          @defer (on viewport) {
            <demo-sortable-board />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="groupEx" label="component" lang="ts" />
      </docs-section>

      <docs-section title="Nested lists" id="nested">
        <p>
          Nested lists work by nesting the bindings. For nested lists in one
          group the innermost target wins, and you can gate moves with a
          <code>canReceive</code> guard. Here each card holds its own checklist,
          and checklist items move between cards.
        </p>
        <docs-demo title="Reorder cards, and rows within them">
          @defer (on viewport) {
            <demo-sortable-nested />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
      </docs-section>

      <docs-section title="Horizontal" id="axis">
        <p>
          Set <code>axis: 'x'</code> for a horizontal list. The gap and the
          drop position follow the axis.
        </p>
        <docs-demo title="Drag a chip sideways">
          @defer (on viewport) {
            <demo-sortable-horizontal />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="axisEx" lang="ts" />
      </docs-section>

      <docs-section title="Styling hooks" id="styling">
        <p>
          The engine is headless. It adds one class to the dragging element,
          <code>mm-sortable-dragging</code>, and exposes the reserved gap size
          as the <code>--mm-sortable-reserved</code> custom property so a
          container can grow as the gap opens. Everything else is your CSS.
        </p>
        <docs-code [code]="cssEx" label="styles" lang="ts" />
      </docs-section>

      <docs-section title="reorderable or injectReorderable" id="inject">
        <p>
          <code>reorderable</code> is a pure factory. It reads no DI, which keeps
          it easy to test but means it does not see the app-wide
          <a mmLink="/docs/dnd/advanced">defaults</a> you may have set. To have a
          list pick up <code>provideDndDefaults</code> and
          <code>provideReorderableDefaults</code>, call
          <code>injectReorderable</code> instead. Same signature: it captures the
          current <code>Injector</code> and hands it to <code>reorderable</code>
          for you. A per-call option still wins over any default.
        </p>
        <docs-code [code]="injectEx" label="component" lang="ts" />
        <p>
          Set the defaults with <code>provideReorderableDefaults</code>, and read
          the resolved value back with <code>injectReorderableDefaults</code>
          (pass an <code>Injector</code> to read outside an injection context).
          These cover the reorderable-only options; the shared
          <code>engine</code> comes from <code>provideDndDefaults</code> unless
          this provider sets it.
        </p>
        <docs-code [code]="defaultsEx" lang="ts" />
      </docs-section>

      <docs-section title="Options" id="options">
        <p>
          Beyond <code>key</code>, <code>engine</code>, <code>axis</code>, and
          <code>group</code> above, the rest of the surface tunes when the insert
          flips, gates cross-list and external drops, and lets you react to each
          kind of move.
        </p>
        <table class="opts">
          <thead>
            <tr>
              <th>Option</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>deadband</code></td>
              <td>
                Px a center must be cleared by before the insert index flips.
                Higher values calm a jittery reorder. Default <code>4</code>.
              </td>
            </tr>
            <tr>
              <td><code>activationThreshold</code></td>
              <td>
                Px the pointer must travel before a drag activates, so a row
                stays clickable. Pointer engine only. Default <code>5</code>.
              </td>
            </tr>
            <tr>
              <td><code>jumpModifier</code></td>
              <td>
                Predicate over the keyboard event that decides the jump-to-end
                key for the built-in handler. Default Cmd on macOS, Ctrl
                elsewhere.
              </td>
            </tr>
            <tr>
              <td><code>canReceive</code></td>
              <td>
                Cross-list drop guard. Return <code>false</code> to reject an
                item from another list in the group, and the engine tries the
                next innermost accepting container. Rejects a tree node dropped
                into its own subtree, for one.
              </td>
            </tr>
            <tr>
              <td><code>insert</code></td>
              <td>
                Accept a payload dragged from outside any list, like a palette
                <code>draggable</code>. <code>accepts</code> qualifies the raw
                payload and <code>create(data, index)</code> maps it to a list
                item. Native engine only.
              </td>
            </tr>
            <tr>
              <td><code>animation</code></td>
              <td>
                The during-drag reflow glide (<code
                  >{{ '{' }} duration, easing {{ '}' }}</code
                >), or <code>false</code> for instant reflow. This is not a drop
                animation: the drop commit is instant. Default a decisive 200ms.
              </td>
            </tr>
            <tr>
              <td><code>autoScroll</code></td>
              <td>
                Opt-in edge auto-scroll while dragging, as
                <code
                  >{{ '{' }} edge, speed, edgeProportion?, maxSpeedAt? {{ '}' }}</code
                >. Needs an auto-scroll plugin (see the
                <a mmLink="/docs/dnd/advanced">advanced page</a>); without one a
                dev warning fires and scrolling no-ops.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Four callbacks report each kind of move after it commits:
          <code>onReorder</code> for a same-list move
          (<code>{{ '{' }} from, to, items {{ '}' }}</code>),
          <code>onItemLeft</code> on the source when an item is dragged into
          another list, <code>onItemArrived</code> on the target when one
          arrives, and <code>onItemInserted</code> after an external
          <code>insert</code> lands.
        </p>
      </docs-section>

      <docs-section title="Keyboard reordering" id="keyboard">
        <p>
          Keyboard reordering is on by default. Focus a row, arrow keys move it
          one step along the axis, and the jump modifier plus an arrow moves it
          to an end. Pass <code>jumpModifier</code> to change the jump key. To
          take over the keys entirely, with your own bindings and behaviour, pass
          <code>onKeyboardKeydown</code>. It runs instead of the built-in handler
          and receives an <code>api</code> whose <code>api.move(to)</code> reuses
          the built-in commit, announce, and focus-restore, so you only decide
          when to move. Ignore <code>api.move</code> to do something else. Set
          <code>keyboard: false</code> to drop the keys and the tabindex
          altogether.
        </p>
        <docs-code [code]="keyboardEx" lang="ts" />
      </docs-section>

      <docs-section title="Cancelling a drag" id="cancel">
        <p>
          Pressing Escape aborts an in-flight drag without committing, and so
          does a <code>pointercancel</code> (a touch scroll taking over, say).
          Items glide back and nothing is spliced. Only a real release commits.
          Both engines behave the same way. For a programmatic abort, the
          controller exposes <code>cancel()</code>.
        </p>
        <docs-code [code]="cancelEx" lang="ts" />
      </docs-section>
    </docs-page>
  `,
  styles: `
    .defer-hint {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin: 0;
    }
    table.opts {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    table.opts th,
    table.opts td {
      text-align: left;
      vertical-align: top;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--border, #e2e8f0);
    }
    table.opts th {
      color: var(--fg-muted);
      font-weight: 600;
    }
  `,
})
export class ReorderableDoc {
  protected readonly listEx = `import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

@Component({
  imports: [Reorderable, ReorderableItem],
  template: \`
    <ul [mmReorderable]="list">
      @for (task of list.items(); track task.id) {
        <li [mmReorderableItem]="task">{{ task.label }}</li>
      }
    </ul>
  \`,
})
class TaskList {
  private readonly data = signal([{ id: 1, label: 'First' }]);
  protected readonly list = reorderable(this.data, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'y',
  });
}`;

  protected readonly groupEx = `import { reorderable, sortableGroup } from '@mmstack/dnd';

const group = sortableGroup<Card>();

const todo = reorderable(todoSignal, { engine: 'pointer', key: (c) => c.id, group });
const done = reorderable(doneSignal, { engine: 'pointer', key: (c) => c.id, group });`;

  protected readonly axisEx = `reorderable(tags, { engine: 'pointer', key: (t) => t.id, axis: 'x' });`;

  protected readonly cssEx = `.item.mm-sortable-dragging {
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}

.list {
  padding-bottom: calc(8px + var(--mm-sortable-reserved, 0px));
}`;

  protected readonly injectEx = `import { injectReorderable } from '@mmstack/dnd';

class TaskList {
  private readonly data = signal([{ id: 1, label: 'First' }]);
  // resolves provideDndDefaults / provideReorderableDefaults for this list
  protected readonly list = injectReorderable(this.data, { key: (t) => t.id });
}`;

  protected readonly defaultsEx = `import {
  injectReorderableDefaults,
  provideReorderableDefaults,
} from '@mmstack/dnd';

provideReorderableDefaults({ axis: 'x', animation: { duration: 150 } });

const resolved = injectReorderableDefaults(); // ReorderableDefaults | null`;

  protected readonly keyboardEx = `reorderable(this.items, {
  key: (t) => t.id,
  jumpModifier: (e) => e.shiftKey, // Shift + arrow jumps to an end
  onKeyboardKeydown: (e, { index, total, move }) => {
    if (e.key === 'j') { e.preventDefault(); move(Math.min(index + 1, total - 1)); }
    if (e.key === 'k') { e.preventDefault(); move(Math.max(index - 1, 0)); }
  },
});`;

  protected readonly cancelEx = `const list = reorderable(this.items, { key: (t) => t.id });

// abort the current drag from code (items glide back, no splice):
list.cancel();`;
}
