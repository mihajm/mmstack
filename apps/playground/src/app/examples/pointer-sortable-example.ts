import { Component, signal } from '@angular/core';
import {
  Reorderable,
  ReorderableHandle,
  ReorderableItem,
  reorderable,
  sortableGroup,
} from '@mmstack/dnd';

type Task = { id: number; label: string };

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-pointer-sortable-example',
  imports: [Reorderable, ReorderableItem, ReorderableHandle],
  template: `
    <main>
      <h1>Pointer sortable — single vertical list</h1>
      <p class="hint">
        Drag a row to reorder. Pointer-based (not native HTML5 drag).
      </p>

      <ul class="list" data-list="pointer" [mmReorderable]="list">
        @for (task of list.items(); track task.id) {
          <li class="item" [mmReorderableItem]="task">
            <span class="grip" aria-hidden="true">⠿</span>
            {{ task.label }}
          </li>
        }
      </ul>

      <h2>Drag handle (item body stays scrollable on touch)</h2>
      <ul class="list" data-list="pointer-handle" [mmReorderable]="listHandle">
        @for (row of listHandle.items(); track row.id) {
          <li class="item" [mmReorderableItem]="row">
            <span class="grip" mmReorderableHandle aria-hidden="true">⠿</span>
            {{ row.label }}
          </li>
        }
      </ul>

      <h2>Cross-list (shared group)</h2>
      <p class="hint">Drag cards between the two columns.</p>
      <div class="board">
        <ul class="list col" data-list="todo" [mmReorderable]="todoList">
          @for (card of todoList.items(); track card.id) {
            <li class="item" [mmReorderableItem]="card">{{ card.label }}</li>
          }
        </ul>
        <ul class="list col" data-list="doing" [mmReorderable]="doingList">
          @for (card of doingList.items(); track card.id) {
            <li class="item" [mmReorderableItem]="card">{{ card.label }}</li>
          }
        </ul>
      </div>

      <h2>Nested lists</h2>
      <p class="hint">
        Drag a card by its <strong>header</strong> to reorder cards; drag a
        checklist row to reorder within a card or move it between cards.
      </p>
      <ul class="list" data-list="outer" [mmReorderable]="outer">
        @for (card of outer.items(); track card.id) {
          <li
            class="card"
            [attr.data-card]="card.id"
            [mmReorderableItem]="card"
          >
            <strong class="card-header" mmReorderableHandle>
              <span class="grip" aria-hidden="true">⠿</span>{{ card.title }}
            </strong>
            <ul
              class="list nested"
              [attr.data-list]="'check-' + card.id"
              [mmReorderable]="card.list"
            >
              @for (t of card.list.items(); track t.id) {
                <li class="item" [mmReorderableItem]="t">{{ t.label }}</li>
              }
            </ul>
          </li>
        }
      </ul>

      <h2>Nested containers — cross-level (one group)</h2>
      <p class="hint">
        Drag items between the outer list and the container nested inside
        "Folder" (and back out). One shared group spanning both levels.
      </p>
      <ul class="list" data-list="t-outer" [mmReorderable]="tOuterCtl">
        @for (it of tOuterCtl.items(); track it.id) {
          <li class="item" data-titem [mmReorderableItem]="it">
            {{ it.label }}
            @if (it.id === 2) {
              <ul
                class="list tree-inner"
                data-list="t-inner"
                [mmReorderable]="tInnerCtl"
              >
                @for (c of tInnerCtl.items(); track c.id) {
                  <li class="item" [mmReorderableItem]="c">{{ c.label }}</li>
                }
              </ul>
            }
          </li>
        }
      </ul>

      <h2>Auto-scroll (scrollable container)</h2>
      <p class="hint">
        Drag toward the top/bottom edge — the container scrolls.
      </p>
      <div class="scroll-box">
        <ul class="list" data-list="scroll" [mmReorderable]="listScroll">
          @for (it of listScroll.items(); track it.id) {
            <li class="item" [mmReorderableItem]="it">{{ it.label }}</li>
          }
        </ul>
      </div>

      <h2>Horizontal (axis: 'x')</h2>
      <ul class="list list-h" data-list="pointer-h" [mmReorderable]="listH">
        @for (tag of listH.items(); track tag.id) {
          <li class="chip" [mmReorderableItem]="tag">{{ tag.label }}</li>
        }
      </ul>
    </main>
  `,
  styles: `
    /* Headless: only layout + a faint default; everything is overridable. */
    main {
      max-width: 30rem;
      margin: 2rem auto;
      font:
        14px/1.4 system-ui,
        sans-serif;
    }
    .hint {
      color: #6b7280;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      cursor: grab;
    }
    /* generous hit target around the glyph (icon size unchanged) */
    .grip {
      color: #9ca3af;
      cursor: grab;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      margin: -8px 0 -8px -4px;
      min-width: 24px;
      min-height: 24px;
      touch-action: none;
    }
    /* The one styling hook the engine exposes — fully overridable. */
    .item.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: #c7d2fe;
      opacity: 0.95;
    }
    /* handle list: only the grip is grabbable, so the body must not look it */
    ul[data-list='pointer-handle'] .item {
      cursor: default;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 8px;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 6px;
      border-radius: 6px;
      background: #f3f4f6;
      font-weight: 600;
      cursor: grab;
    }
    .card-header .grip {
      color: #9ca3af;
      margin: 0;
      padding: 0;
      min-width: 0;
      min-height: 0;
    }
    .nested {
      /* indent so the hierarchy reads as nested */
      margin-left: 14px;
      padding: 4px;
      min-height: 44px;
      border-left: 2px solid #eceef1;
      /* opt in to the engine's reserved space so the gap opens cleanly */
      padding-bottom: calc(4px + var(--mm-sortable-reserved, 0px));
    }
    .tree-inner {
      margin: 8px 0 0 16px;
      padding: 6px;
      min-height: 40px;
      background: #f9fafb;
      border-left: 2px solid #d1d5db;
      border-radius: 6px;
      padding-bottom: calc(6px + var(--mm-sortable-reserved, 0px));
    }
    .scroll-box {
      max-height: 180px;
      overflow: auto;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 6px;
    }
    .board {
      display: flex;
      gap: 16px;
      align-items: start;
    }
    .col {
      flex: 1;
      min-height: 80px;
      padding: 8px;
      background: #f9fafb;
      border-radius: 10px;
      /* opt in to the engine's reserved space so the column grows with the gap */
      padding-bottom: calc(8px + var(--mm-sortable-reserved, 0px));
    }
    .list-h {
      flex-direction: row;
      flex-wrap: nowrap;
    }
    .chip {
      padding: 10px 16px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 999px;
      cursor: grab;
      white-space: nowrap;
    }
    .chip.mm-sortable-dragging {
      cursor: grabbing;
      box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      border-color: #c7d2fe;
    }
  `,
})
export class PointerSortableExample {
  protected readonly data = signal<Task[]>([
    { id: 1, label: 'Auth flow' },
    { id: 2, label: 'Billing page' },
    { id: 3, label: 'Search filters' },
    { id: 4, label: 'Dashboard charts' },
    { id: 5, label: 'Settings panel' },
  ]);

  protected readonly list = reorderable(this.data, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'y',
  });

  protected readonly tags = signal<Task[]>([
    { id: 1, label: 'urgent' },
    { id: 2, label: 'design' },
    { id: 3, label: 'backend' },
    { id: 4, label: 'docs' },
    { id: 5, label: 'wontfix' },
  ]);

  protected readonly listH = reorderable(this.tags, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'x',
  });

  protected readonly rows = signal<Task[]>([
    { id: 1, label: 'Alpha' },
    { id: 2, label: 'Beta' },
    { id: 3, label: 'Gamma' },
    { id: 4, label: 'Delta' },
    { id: 5, label: 'Epsilon' },
  ]);

  protected readonly listHandle = reorderable(this.rows, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'y',
  });

  // cross-list: two columns sharing one group
  private readonly board = sortableGroup<Task>();
  protected readonly todo = signal<Task[]>([
    { id: 1, label: 'Spec API' },
    { id: 2, label: 'Write docs' },
    { id: 3, label: 'Add tests' },
  ]);
  protected readonly doing = signal<Task[]>([
    { id: 4, label: 'Build engine' },
    { id: 5, label: 'Review PR' },
  ]);
  protected readonly todoList = reorderable(this.todo, {
    engine: 'pointer',
    key: (t) => t.id,
    group: this.board,
  });
  protected readonly doingList = reorderable(this.doing, {
    engine: 'pointer',
    key: (t) => t.id,
    group: this.board,
  });

  // auto-scroll: a tall list in a fixed-height scroll container
  protected readonly scrollItems = signal<Task[]>(
    Array.from({ length: 15 }, (_, i) => ({
      id: 100 + i,
      label: `Item ${i + 1}`,
    })),
  );
  protected readonly listScroll = reorderable(this.scrollItems, {
    engine: 'pointer',
    key: (t) => t.id,
    axis: 'y',
    autoScroll: {}, // opt in — mechanism comes from the registered `edgeAutoScroll` plugin
  });

  // nested: an outer card list; each card holds its own checklist, and the
  // nested lists share a group so checklist items move between cards.
  private readonly checkGroup = sortableGroup<Task>();
  private card(id: number, title: string, items: Task[]) {
    const sig = signal(items);
    // reorderable() doesn't inject — fine to build one per card here.
    return {
      id,
      title,
      list: reorderable(sig, {
        engine: 'pointer',
        key: (t) => t.id,
        group: this.checkGroup,
      }),
    };
  }
  protected readonly cards = signal([
    this.card(1, 'Backlog', [
      { id: 11, label: 'Step A' },
      { id: 12, label: 'Step B' },
    ]),
    this.card(2, 'In progress', [{ id: 21, label: 'Step C' }]),
    this.card(3, 'Done', [
      { id: 31, label: 'Step D' },
      { id: 32, label: 'Step E' },
    ]),
  ]);
  protected readonly outer = reorderable(this.cards, {
    engine: 'pointer',
    key: (c) => c.id,
  });

  // cross-level nesting: outer list + a container nested in one of its items,
  // both in ONE group, so items move between levels.
  private readonly treeGroup = sortableGroup<Task>();
  protected readonly tOuter = signal<Task[]>([
    { id: 1, label: 'Item 1' },
    { id: 2, label: 'Folder' },
    { id: 3, label: 'Item 3' },
  ]);
  protected readonly tInner = signal<Task[]>([
    { id: 10, label: 'Nested A' },
    { id: 11, label: 'Nested B' },
  ]);
  protected readonly tOuterCtl = reorderable(this.tOuter, {
    engine: 'pointer',
    key: (t) => t.id,
    group: this.treeGroup,
  });
  protected readonly tInnerCtl = reorderable(this.tInner, {
    engine: 'pointer',
    key: (t) => t.id,
    group: this.treeGroup,
  });
}
