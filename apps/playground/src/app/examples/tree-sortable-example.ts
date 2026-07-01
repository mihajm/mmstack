import { Component, Input, signal, type WritableSignal } from '@angular/core';
import {
  Reorderable,
  reorderable,
  ReorderableHandle,
  ReorderableItem,
  sortableGroup,
  type ReorderableController,
} from '@mmstack/dnd';

export type TreeNode = {
  id: number;
  label: string;
  children: WritableSignal<TreeNode[]>;
  controller: ReorderableController<TreeNode, number>;
};

/** Is `node` somewhere inside `item`'s subtree (incl. `item` itself)? */
function subtreeContains(item: TreeNode, node: TreeNode): boolean {
  if (item === node) return true;
  for (const c of item.children()) if (subtreeContains(c, node)) return true;
  return false;
}

/**
 * One recursive node: a grip-handle label + its own nested sortable list of
 * children, each of which is another `app-tree-node`. The directives are plain
 * wiring — every node's list shares the same group, so an item drags across any
 * level. Recursion via the standalone component importing itself.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-tree-node',
  imports: [Reorderable, ReorderableItem, ReorderableHandle, TreeNodeComponent],
  template: `
    <span class="tn-label" mmReorderableHandle>
      <span class="grip" aria-hidden="true">⠿</span>{{ node.label }}
    </span>
    <ul
      class="tn-children"
      [attr.data-node]="node.id"
      [mmReorderable]="node.controller"
    >
      @for (child of node.controller.items(); track child.id) {
        <li class="tn" [mmReorderableItem]="child">
          <app-tree-node [node]="child" />
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .tn-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: grab;
      background: #fff;
      border: 1px solid #e5e7eb;
      font-weight: 500;
    }
    .grip {
      color: #9ca3af;
    }
    .tn-children {
      list-style: none;
      margin: 4px 0 4px 18px;
      padding: 4px 0 4px 12px;
      border-left: 2px solid #e5e7eb;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 16px;
      /* opt in to the engine's reserved space so the gap opens cleanly */
      padding-bottom: calc(4px + var(--mm-sortable-reserved, 0px));
    }
    .tn {
      position: relative;
    }
    .tn-label.mm-sortable-dragging {
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: #c7d2fe;
    }
  `,
})
export class TreeNodeComponent {
  @Input({ required: true }) node!: TreeNode;
}

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-tree-sortable-example',
  imports: [Reorderable, ReorderableItem, TreeNodeComponent],
  template: `
    <main>
      <h1>Nested tree — drag across any level</h1>
      <p class="hint">
        Drag a node by its grip into any list, at any depth — including out to a
        parent or down into a child. A node can't be dropped into its own
        subtree.
      </p>
      <ul
        class="tn-children tn-root"
        data-node="root"
        [mmReorderable]="root.controller"
      >
        @for (child of root.controller.items(); track child.id) {
          <li class="tn" [mmReorderableItem]="child">
            <app-tree-node [node]="child" />
          </li>
        }
      </ul>
    </main>
  `,
  styles: `
    main {
      max-width: 32rem;
      margin: 2rem auto;
      font:
        14px/1.4 system-ui,
        sans-serif;
    }
    .hint {
      color: #6b7280;
    }
    .tn-root {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-left: none;
    }
  `,
})
export class TreeSortableExample {
  private readonly group = sortableGroup<TreeNode>();

  private node(id: number, label: string, children: TreeNode[] = []): TreeNode {
    const sig = signal(children);
    const node = { id, label, children: sig } as TreeNode;
    node.controller = reorderable(sig, {
      engine: 'pointer',
      key: (n) => n.id,
      group: this.group,
      // cycle guard: reject an item whose subtree already contains this node.
      canReceive: (item) => !subtreeContains(item, node),
    });
    return node;
  }

  protected readonly root = this.node(0, 'root', [
    this.node(1, 'Documents', [
      this.node(11, 'Resume.pdf'),
      this.node(12, 'Cover letter.pdf'),
    ]),
    this.node(2, 'Projects', [
      this.node(21, 'mmstack', [
        this.node(211, 'dnd'),
        this.node(212, 'primitives'),
      ]),
      this.node(22, 'playground'),
    ]),
    this.node(3, 'Photos'),
  ]);
}
