# sortable — PREVIEW (app-internal)

> **Not yet published.** These batteries live in the playground app while they're
> polished (see [`gap.md`](./gap.md)). They're built entirely on the public
> `@mmstack/dnd` core; when the moving-gap is flagship-grade they graduate back to
> `@mmstack/dnd`. Imports below show the *intended* published API.

Opinionated sortable-list batteries on top of the core binding: `reorderable`
(single- and cross-list) and a contained `DropIndicator`. **No hitbox needed** —
the insertion point is computed by pointer-vs-center collision (rects cached at
drag start), so it works zero-config and is gap-safe.

## `reorderable`

Pass a `WritableSignal<T[]>`; reordering is a **pure splice on your signal** and
the indicator position is derived. No parallel order state, no copy effects.

```ts
import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Card = { id: number; label: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

@Component({
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (card of list.items(); track list.key(card)) {
        <li [mmReorderableItem]="card">{{ card.label }}</li>
      } @empty {
        <li>drop a card here</li>
      }
    </ul>
  `,
})
export class List {
  readonly cards = signal<Card[]>([/* … */]);
  protected readonly list = reorderable(this.cards, {
    accepts: isCard,
    key: (c) => c.id,
    // group: 'cards',           // share a string to exchange items across lists
    // edges: ['top', 'bottom'], // default
    // indicated: true,          // default — render the insertion line on items
    // keyboard: true,           // focusable items; Arrow = 1 step, Ctrl/Cmd+Arrow = jump to end
    // onReorder / onItemArrived / onItemLeft
  });
}
```

- **Single source of truth:** the indicator and each item's `index` derive from
  `list.items()` (one O(n) key→index map). DOM reuse on reorder comes from
  Angular's `@for` `track`.
- **Cross-list:** give two reorderables the same `group` string; items dropped
  from one list arrive in the other (`onItemArrived` / `onItemLeft`).
- **Nested lists:** a reorderable nested inside another reorderable's item (same
  `group`) resolves to the **innermost** list — the drop lands there only, never
  double-inserting into the outer list.
- **flourish (post-move flash):** register `provideDnd({ plugins: { postMoveFlash } })`
  and call it from `onReorder`.
- **Collision-based insertion (no jank):** the insert index is computed by
  **pointer-vs-item-center collision against rects cached at drag start** — stable
  (an opening gap / moving line can't feed back → no shake) and gap-safe (works in
  the dead space between items → the line never flashes to the end). One folded
  line per list: "after A" and "before B" resolve to the same index. Only the
  innermost hovered list shows it; empty lists get a container-level line.
- **Faded source:** each `mmReorderableItem` exposes `dragging()` — bind it to dim
  the dragged "ghost" in indicator mode (e.g. `[class.dragging]="d.dragging()"`).
- **Placeholder style:** `placeholder: 'indicator'` (default) draws that line;
  `placeholder: 'gap'` instead pulls the dragged item out of flow and opens an
  equal-sized gap at the drop position (net-zero height, no shake; line
  suppressed). Effect-free until you opt in.
- **Tip:** add `user-select: none` to draggable items so a stray text selection
  can't start a native text-drag instead of your drag.

### Inserting from outside the list (palettes)

To accept items dragged from a plain `draggable` (e.g. a palette of field types)
whose payload isn't a list item, give the list an `insert` — `accepts` qualifies
the dragged payload, `create` maps it to a list item dropped at the edge index:

```ts
protected readonly list = reorderable(this.cards, {
  accepts: isCard,
  key: (c) => c.id,
  insert: {
    accepts: isFieldType,                          // a non-Card palette payload
    create: (field, index) => buildCard(field),    // mapped into the list at `index`
  },
  // onItemInserted: ({ item, to, source }) => …
});
```

The palette stays a plain `draggable` — native drag means the source is never
moved, so it behaves like a clone source automatically.

## `DropIndicator`

A self-positioning insertion line as a **contained component** with
**component-encapsulated styles — no global `<style>` injection, no `::before`**.
Overlay it on a positioned (`position: relative`) drop target:

```html
<div mmDropTarget #dt="mmDropTarget" [accepts]="isCard" [edges]="['top','bottom']" style="position: relative">
  …
  <mm-drop-indicator [edge]="dt.closestEdge()" />
</div>
```

Theme with `--mm-drop-indicator-color`; size via `thickness` / `gap`. Pass
`[edgeSource]="aSignal"` (a `Signal<Edge|null>`) to drive it without a copy
effect — that's how `reorderable` renders the line inside each item.
