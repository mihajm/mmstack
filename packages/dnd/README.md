# @mmstack/dnd

An Angular wrapper around [@atlaskit/pragmatic-drag-and-drop](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop) with typed payloads, signal-based state, and a thin function + directive pairing.

[![npm version](https://badge.fury.io/js/%40mmstack%2Fdnd.svg)](https://badge.fury.io/js/%40mmstack%2Fdnd)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/dnd/LICENSE)

## Installation

```bash
npm install @mmstack/dnd @atlaskit/pragmatic-drag-and-drop @atlaskit/pragmatic-drag-and-drop-hitbox
```

## Primitives

- `draggable<TData, TMeta>(opts)` / `Draggable` — make an element draggable with a typed payload (and optional typed metadata).
- `dropTarget<TAccept, TSelf, TMeta>(opts)` / `DropTarget` — make an element a drop target with type-narrowing accept, optional edge detection, and a built-in drop indicator opt-in.
- `monitorElements<TAccept, TMeta>(opts)` — global drag-state observer.
- `mmDropIndicator` / `<mm-drop-indicator>` — visual insertion-line driven by an `Edge | null` signal.
- `mmDragHandle` — restrict drag initiation to a specific child element.
- `reorderable<T>(items, opts)` + `mmReorderable` / `mmReorderableItem` — opinionated sortable list (single or cross-list via `group`).
- Custom drag previews via the `preview` option on `draggable()`.

Every composable is a function. Every directive is a thin wrapper that forwards inputs into the composable and exposes its signal state. You can compose at either level depending on your taste.

---

### draggable

Attaches drag behaviour to the host element with a strongly typed payload.

```typescript
import { Component, signal } from '@angular/core';
import { draggable } from '@mmstack/dnd';

type Card = { id: string; title: string };

@Component({
  selector: 'app-card',
  template: `{{ card().title }}`,
  host: { '[class.dragging]': 'dnd.dragging()' },
})
export class CardComponent {
  readonly card = signal<Card>({ id: '1', title: 'Hello' });

  protected readonly dnd = draggable<Card>({
    data: this.card,
    onDrop: ({ data, location }) => {
      console.log('dropped', data, 'onto', location.current);
    },
  });
}
```

Or use the directive:

```html
<div mmDraggable [data]="card()" #d="mmDraggable" [class.dragging]="d.dragging()" (dropped)="onDrop($event)">
  {{ card().title }}
</div>
```

### dropTarget

Accepts a typeguard that narrows incoming payloads. All events and signals are typed against `TAccept` — no casting required.

```typescript
import { Component, signal } from '@angular/core';
import { dropTarget } from '@mmstack/dnd';

type Card = { id: string; title: string };
const isCard = (d: unknown): d is Card =>
  typeof d === 'object' && d !== null && 'id' in d && 'title' in d;

@Component({
  selector: 'app-column',
  template: `
    @for (c of cards(); track c.id) {
      <p>{{ c.title }}</p>
    }
  `,
  host: { '[class.over]': 'zone.isDragOver()' },
})
export class ColumnComponent {
  readonly cards = signal<Card[]>([]);

  protected readonly zone = dropTarget<Card>({
    accepts: isCard,
    onDrop: ({ data }) => this.cards.update((cs) => [...cs, data]),
  });
}
```

Pass `edges` to enable closest-edge tracking for list-reorder UIs:

```typescript
const slot = dropTarget<Card, { index: number }>({
  accepts: isCard,
  data: () => ({ index: this.index() }),
  edges: ['top', 'bottom'],
  onDrop: ({ data, ...args }) => {
    // args.location.current[0].data carries the slot's `{ index }`
  },
});

// slot.closestEdge() → 'top' | 'bottom' | null
```

The `dropped` event also carries the edge at drop time (`event.edge`) so list-reorder handlers don't have to grab it from the directive's transient signal.

### DragHandle

Restrict drag-initiation to a specific child element. The `mmDragHandle` directive captures its host `ElementRef` and exposes itself via `exportAs: 'mmDragHandle'` — pass it into a `mmDraggable`'s `dragHandle` input:

```html
<li mmDraggable [data]="item" [dragHandle]="grip">
  <span mmDragHandle #grip="mmDragHandle" class="grip">⋮⋮</span>
  <span>{{ item.label }}</span>
</li>
```

The composable form (`draggable({ dragHandle: ... })`) accepts the same shapes: an `HTMLElement`, an `ElementRef`, the `DragHandle` directive instance, or a signal/getter of any of these.

### DropIndicator

A self-positioning insertion line driven by an `Edge | null` signal. There are three ways to use it:

**1. Opt in directly on the drop target** (recommended for the common case — `closestEdge` is wired automatically):

```html
<div mmDropTarget [accepts]="isCard" [edges]="['top', 'bottom']" indicated>
  {{ item().title }}
</div>
```

**2. As a standalone directive** (e.g., to drive from a custom signal):

```html
<div mmDropIndicator [edge]="someEdgeSignal()">…</div>
```

**3. As a component** (when you need to overlay the indicator on a positioned wrapper rather than on the drop target itself):

```html
<div mmDropTarget [accepts]="isCard" [edges]="['top','bottom']" #dt="mmDropTarget" style="position: relative">
  {{ item().title }}
  <mm-drop-indicator [edge]="dt.closestEdge()" />
</div>
```

Under the hood the directive injects a single shared `<style>` tag into `document.head` on first use and renders the line via `::before`, so it never adds DOM children to your element. Theming via the `--mm-drop-indicator-color` CSS custom property; positioning via `thickness` / `gap` (also exposed on the drop target as `indicatorThickness` / `indicatorGap`).

### monitorElements

Observe drag state globally — useful for cross-cutting UI like dim-others-while-dragging or showing a global drop hint.

```typescript
import { Component } from '@angular/core';
import { monitorElements } from '@mmstack/dnd';

@Component({
  selector: 'app-shell',
  template: `<div [class.is-dragging]="monitor.isDragging()">...</div>`,
})
export class ShellComponent {
  protected readonly monitor = monitorElements<Card>({
    accepts: isCard,
  });
}
```

### reorderable

Higher-level abstraction for sortable lists. Pass it a `WritableSignal<T[]>` and it gives you a `ReorderableRef<T>` to bind to two directives. Same-list reorder and (opt-in) cross-list reorder via a shared `group` string. Drop indicators are on by default.

```typescript
import { Component, signal } from '@angular/core';
import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Card = { id: number; label: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d && 'label' in d;

@Component({
  selector: 'app-list',
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
  readonly cards = signal<Card[]>([…]);

  protected readonly list = reorderable(this.cards, {
    accepts: isCard,
    key: (c) => c.id,
    // group: 'cards',  // optional — enables cross-list with other reorderables sharing this string
    // edges: ['top', 'bottom'],  // default
    // indicated: true,            // default — drop indicators
    // onReorder: (e) => …,
    // onItemArrived: (e) => …,  // cross-list arrival
    // onItemLeft: (e) => …,     // cross-list departure
  });
}
```

The `mmReorderable` directive applies a container drop target so items can be dropped onto an empty list or at the end. The container's host element should set its own layout (flexbox/grid/etc.) — `reorderable` doesn't impose styling.

### Custom drag previews

Pass a `preview` option to `draggable()` to render an Angular component, `TemplateRef`, or raw DOM as the native drag image.

```typescript
@Component({
  template: `
    <ng-template #preview let-card>
      <div class="preview">{{ card.title }}</div>
    </ng-template>

    <div mmDraggable [data]="card()" [preview]="previewCfg()">{{ card().title }}</div>
  `,
})
export class CardComponent {
  protected readonly preview = viewChild<TemplateRef<{ $implicit: Card }>>('preview');

  protected readonly previewCfg = computed(() => ({
    template: this.preview(),
    context: this.card(),
    offset: 'pointer-outside' as const,
  }));
}
```

Options: `{ component, inputs?, offset? }` for an Angular component, `{ template, context?, offset? }` for a `TemplateRef`, or `{ render, offset? }` as a raw imperative escape hatch. `offset` is either `'pointer-outside'` (positions the preview just outside the cursor) or `{ x, y }` pixel offsets relative to the preview's top-left.

### Drag metadata (`meta`)

Both `draggable()` and `dropTarget()` carry a typed `meta` payload alongside the user's `data`. The source attaches it, the target reads it from `event.meta` / `canDrop`'s args. Typed via the optional second generic parameter:

```typescript
const KIND = Symbol('kind');
type CardMeta = { [KIND]: 'todo' | 'done' };

draggable<Card, CardMeta>({
  data: this.card,
  meta: () => ({ [KIND]: 'todo' }),
});

dropTarget<Card, void, CardMeta>({
  accepts: isCard,
  canDrop: ({ source: { meta } }) => meta[KIND] === 'todo',
  onDrop: ({ data, meta }) => { /* meta[KIND] is typed */ },
});
```

`meta` is the seam to build your own higher-level abstractions on top of `@mmstack/dnd`. `reorderable` itself uses it internally for cross-list discrimination.

### Autoscroll

`@mmstack/dnd` does **not** bundle `@atlaskit/pragmatic-drag-and-drop-auto-scroll` — install it yourself and call it on your container ref. It composes cleanly with our drop targets:

```typescript
import { ElementRef, inject, afterNextRender } from '@angular/core';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

@Component({…})
export class ScrollableList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => autoScrollForElements({ element: this.host.nativeElement }));
  }
}
```

### Accessibility flash

Likewise we don't bundle `@atlaskit/pragmatic-drag-and-drop-flourish`. To draw the eye to a moved element after a programmatic move, install the package yourself and wire it through one of `reorderable`'s event hooks (`onReorder`, `onItemArrived`):

```typescript
import { triggerPostMoveFlash } from '@atlaskit/pragmatic-drag-and-drop-flourish/trigger-post-move-flash';

reorderable(items, {
  accepts: isCard,
  key: (c) => c.id,
  onReorder: ({ item }) => {
    afterNextRender(() => {
      const el = host.querySelector(`[data-id="${item.id}"]`);
      if (el) triggerPostMoveFlash(el);
    });
  },
});
```

(The DOM-element lookup is layout-specific; use whatever query/ref pattern fits your template.)

---

## SSR

All composables short-circuit on the server and return inert signals (`dragging` always false, `isDragOver` always false, etc.), so they're safe to call from components that are server-rendered.

## License

MIT © [Miha Mulec](https://github.com/mihajm)
