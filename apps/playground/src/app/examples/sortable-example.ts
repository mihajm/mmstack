import { Component, signal } from '@angular/core';
import { Draggable, injectAnnounce } from '@mmstack/dnd';

import { Reorderable, ReorderableItem, reorderable } from '../sortable/reorderable';

type Task = { id: number; label: string };
type FieldType = { kind: string; label: string };
type Block = { bid: number; label: string };

const isTask = (d: unknown): d is Task =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;
const isFieldType = (d: unknown): d is FieldType =>
  !!d && typeof d === 'object' && 'kind' in d;
const isBlock = (d: unknown): d is Block =>
  !!d && typeof d === 'object' && 'bid' in d;

/**
 * Sortable example: two `reorderable` lists sharing a `group` (cross-list move),
 * a palette of `draggable` chips that `insert` into a list at the drop index,
 * and a nested reorderable-in-reorderable proving the innermost target wins.
 */
@Component({
  selector: 'mm-sortable-example',
  imports: [Draggable, Reorderable, ReorderableItem],
  template: `
    <h2>Sortable — reorder, move across lists, insert &amp; nest</h2>
    <p class="hint">
      Drag to reorder, or drag across lists (shared <code>group</code>). Focus a
      card and use <kbd>↑</kbd>/<kbd>↓</kbd> (<kbd>Ctrl</kbd>+arrow jumps to the
      end). Needs the hitbox plugin (registered in <code>app.config</code>).
    </p>

    <h3>Field palette → drop into Backlog</h3>
    <p class="hint">
      These chips aren't list items — they're plain <code>draggable</code>s whose
      payload is mapped into a Backlog task via the list's <code>insert</code>.
    </p>
    <div class="palette">
      @for (f of fieldTypes; track f.kind) {
        <div class="chip" mmDraggable [data]="f">{{ f.label }}</div>
      }
    </div>

    <div class="lists">
      <div class="list-wrap">
        <h3>Backlog</h3>
        <ul [mmReorderable]="backlog">
          @for (t of backlog.items(); track backlog.key(t)) {
            <li
              [mmReorderableItem]="t"
              #d="mmReorderableItem"
              [class.dragging]="d.dragging()"
              [attr.aria-label]="t.label"
              aria-roledescription="Sortable item. Press arrow keys to reorder."
            >
              {{ t.label }}
            </li>
          } @empty {
            <li class="empty">drop here</li>
          }
        </ul>
      </div>

      <div class="list-wrap">
        <h3>Sprint</h3>
        <ul [mmReorderable]="sprint">
          @for (t of sprint.items(); track sprint.key(t)) {
            <li
              [mmReorderableItem]="t"
              #d="mmReorderableItem"
              [class.dragging]="d.dragging()"
              [attr.aria-label]="t.label"
              aria-roledescription="Sortable item. Press arrow keys to reorder."
            >
              {{ t.label }}
            </li>
          } @empty {
            <li class="empty">drop here</li>
          }
        </ul>
      </div>
    </div>

    <h3>Nested lists (innermost wins)</h3>
    <p class="hint">
      The inner list lives inside an outer item, both sharing one
      <code>group</code>. Dropping into the inner list must land there only — the
      outer must not also receive it.
    </p>
    <ul class="outer" [mmReorderable]="blocks" data-list="outer">
      @for (b of blocks.items(); track blocks.key(b)) {
        <li [mmReorderableItem]="b" class="block">
          <span>{{ b.label }}</span>
          @if (b.bid === 1) {
            <ul class="inner" [mmReorderable]="inner" data-list="inner">
              @for (ib of inner.items(); track inner.key(ib)) {
                <li [mmReorderableItem]="ib" class="block">{{ ib.label }}</li>
              } @empty {
                <li class="empty">drop inside</li>
              }
            </ul>
          }
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; padding: 1.5rem; font-family: system-ui, sans-serif; }
    h2 { margin: 0 0 .25rem; }
    h3 { margin: 1.25rem 0 .5rem; color: #334155; }
    .hint { color: #64748b; margin: 0 0 1rem; max-width: 60ch; }
    code, kbd { background: #f1f5f9; padding: 0 .3rem; border-radius: 3px; }
    kbd { border: 1px solid #cbd5e1; font-size: .8em; }
    .palette { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .chip { background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3;
      border-radius: 999px; padding: .4rem .8rem; cursor: grab; }
    .lists { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; max-width: 720px; }
    ul {
      list-style: none; margin: 0; padding: .5rem; min-height: 120px;
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
      display: flex; flex-direction: column; gap: .5rem;
    }
    li {
      background: white; border: 1px solid #e2e8f0; border-radius: 6px;
      padding: .6rem .8rem; cursor: grab; box-shadow: 0 1px 2px rgba(0,0,0,.04);
      user-select: none; --mm-drop-indicator-color: #6366f1;
    }
    li:focus-visible { outline: 2px solid #6366f1; outline-offset: 1px; }
    li.dragging { opacity: .4; } /* faded "ghost" of the source in indicator mode */
    .empty { color: #94a3b8; text-align: center; cursor: default; box-shadow: none; background: transparent; border-style: dashed; }
    .outer { max-width: 720px; }
    .inner { margin-top: .5rem; background: #eff6ff; border-color: #bfdbfe; min-height: 60px; }
    .block { display: block; }
  `,
})
export class SortableExample {
  private readonly announcer = injectAnnounce();
  private idSeq = 100;

  private announce(list: string, item: Task, to: number, total: number): void {
    this.announcer(
      `${item.label} moved to position ${to + 1} of ${total} in ${list}`,
    );
  }

  protected readonly fieldTypes: FieldType[] = [
    { kind: 'text', label: 'Text' },
    { kind: 'number', label: 'Number' },
    { kind: 'date', label: 'Date' },
  ];

  protected readonly backlog = reorderable(
    signal<Task[]>([
      { id: 1, label: 'Auth flow' },
      { id: 2, label: 'Billing page' },
      { id: 3, label: 'Email templates' },
      { id: 4, label: 'Search filters' },
    ]),
    {
      accepts: isTask,
      key: (t) => t.id,
      group: 'tasks',
      keyboard: true,
      insert: {
        accepts: isFieldType,
        create: (d) => ({ id: ++this.idSeq, label: `New ${(d as FieldType).label}` }),
      },
      onReorder: (e) => this.announce('Backlog', e.item, e.to, this.backlog.items().length),
      onItemArrived: (e) => this.announce('Backlog', e.item, e.to, this.backlog.items().length),
    },
  );

  protected readonly sprint = reorderable(
    signal<Task[]>([{ id: 5, label: 'Onboarding checklist' }]),
    {
      accepts: isTask,
      key: (t) => t.id,
      group: 'tasks',
      keyboard: true,
      onReorder: (e) => this.announce('Sprint', e.item, e.to, this.sprint.items().length),
      onItemArrived: (e) => this.announce('Sprint', e.item, e.to, this.sprint.items().length),
    },
  );

  // Nested reorderables sharing one group — proves the innermost target wins.
  protected readonly blocks = reorderable(
    signal<Block[]>([
      { bid: 1, label: 'Section' },
      { bid: 2, label: 'Block B' },
      { bid: 3, label: 'Block C' },
    ]),
    { accepts: isBlock, key: (b) => b.bid, group: 'nested' },
  );

  protected readonly inner = reorderable(
    signal<Block[]>([{ bid: 10, label: 'Inner X' }]),
    { accepts: isBlock, key: (b) => b.bid, group: 'nested' },
  );
}
