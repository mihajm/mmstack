# @mmstack/dnd

A signals-first Angular binding for [@atlaskit/pragmatic-drag-and-drop](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop) (v2). Make any element draggable or a drop target with a typed payload, and read every piece of drag state as a `Signal`.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/dnd/LICENSE)

Per-element state (`dragging`, `isDragOver`, `closestEdge`) is derived from a single ambient session signal instead of being stored, so there are no recurring effects on the core path. Each primitive is a composable function paired with a thin directive, and pragmatic's optional sub-libraries plug in through `provideDnd` rather than as peer dependencies.

## Installation

```bash
npm install @mmstack/dnd @atlaskit/pragmatic-drag-and-drop
```

Optional sub-libraries are not peer dependencies. Install only what you use and register it (see [Plugins](#plugins)):

```bash
npm install @atlaskit/pragmatic-drag-and-drop-hitbox       # edge detection
npm install @atlaskit/pragmatic-drag-and-drop-auto-scroll  # auto-scroll
npm install @atlaskit/pragmatic-drag-and-drop-flourish     # post-move flash
```

## Quick start

Drag cards between two columns. `draggable` carries the typed payload, `dropTarget` narrows it with `accepts` and exposes `isDragOver`, and the drop updates your own signal. No plugins required.

```ts
import { Component, signal } from '@angular/core';
import { Draggable, DropTarget } from '@mmstack/dnd';

type Column = 'todo' | 'done';
type Card = { id: number; title: string };

const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

@Component({
  selector: 'app-board',
  imports: [Draggable, DropTarget],
  template: `
    @for (col of columns; track col) {
      <section
        mmDropTarget
        #zone="mmDropTarget"
        [accepts]="isCard"
        [class.over]="zone.isDragOver()"
        (dropped)="move(col, $event.data)"
      >
        <h3>{{ col }}</h3>
        @for (card of board()[col]; track card.id) {
          <article
            mmDraggable
            #d="mmDraggable"
            [data]="card"
            [class.dragging]="d.dragging()"
          >
            {{ card.title }}
          </article>
        }
      </section>
    }
  `,
  styles: `
    :host { display: flex; gap: 1rem; font-family: system-ui, sans-serif; }
    section { flex: 1; min-height: 120px; padding: .75rem; border: 1px solid #e2e8f0; border-radius: 8px; }
    section.over { border-color: #2563eb; background: #eff6ff; }
    h3 { margin: 0 0 .5rem; text-transform: capitalize; }
    article { margin-bottom: .5rem; padding: .5rem .75rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; cursor: grab; user-select: none; }
    article.dragging { opacity: .4; }
  `,
})
export class BoardComponent {
  protected readonly isCard = isCard;
  protected readonly columns: Column[] = ['todo', 'done'];

  protected readonly board = signal<Record<Column, Card[]>>({
    todo: [
      { id: 1, title: 'Design' },
      { id: 2, title: 'Build' },
    ],
    done: [{ id: 3, title: 'Kickoff' }],
  });

  protected move(to: Column, card: Card): void {
    this.board.update((b) => {
      const next: Record<Column, Card[]> = {
        todo: b.todo.filter((c) => c.id !== card.id),
        done: b.done.filter((c) => c.id !== card.id),
      };
      next[to] = [...next[to], card];
      return next;
    });
  }
}
```

`$event.data` is typed `Card` because `accepts` narrows it. Add the [hitbox plugin](#plugins) when you want edge-aware drops (insert before or after a target).

## Primitives

- `draggable<TData, TMeta>(opts)` / `Draggable`: make an element draggable with a typed payload and optional metadata.
- `dropTarget<TAccept, TSelf, TMeta>(opts)` / `DropTarget`: make an element a drop target with a type-narrowing `accepts`, optional edge detection, and derived state.
- `monitor<TAccept, TMeta>(opts)`: global drag-state observer (derived; callbacks optional).
- `fileDropTarget(opts)` / `monitorExternal(opts)`: accept files dragged in from the OS (the external adapter).
- `DragHandle` (`mmDragHandle`): restrict drag initiation to a child element.
- `autoScroll(opts)` / `mmAutoScroll`: edge auto-scroll (needs the auto-scroll plugin).
- `provideDnd(config)`: register optional plugins and scope a session.
- Custom drag previews via the `preview` option on `draggable()`.

Every composable is a function. Every directive is a thin wrapper that forwards inputs into the composable and exposes its signal state.

## The reactive model

`monitorForElements` already broadcasts the full drag world on every move. A root `DndSession` captures it once into a signal, and everything per-element is a `computed`:

```ts
// inside dropTarget()
const isDragOver = computed(() => hitIndex() >= 0);
const closestEdge = computed(() => /* read from the session via the hitbox plugin */);
```

There are no per-element writable signals, no callbacks writing into signals, and no effects copying one signal into another. Pragmatic's config hooks (`getInitialData`, `canDrop`, `getData`) are read lazily, so registration happens once. A reactive `dragHandle` is the only thing that re-registers, and only when the handle element changes.

## draggable

```ts
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
    onDrop: ({ data, edge, location }) => {
      console.log('dropped', data, 'edge', edge, 'onto', location.current);
    },
  });
}
```

Or the directive:

```html
<div
  mmDraggable
  [data]="card()"
  #d="mmDraggable"
  [class.dragging]="d.dragging()"
  (dropped)="onDrop($event)"
>
  {{ card().title }}
</div>
```

## dropTarget

`accepts` is a typeguard that narrows incoming payloads, so all events and signals are typed against `TAccept` with no casting.

```ts
import { dropTarget } from '@mmstack/dnd';

type Card = { id: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

protected readonly zone = dropTarget<Card>({
  accepts: isCard,
  onDrop: ({ data }) => this.cards.update((cs) => [...cs, data]),
});
// zone.isDragOver(), zone.isInnermost(), zone.dragOverData(), zone.closestEdge()
```

`closestEdge` and `edges` need the hitbox plugin (see [Plugins](#plugins)); requesting `edges` without it throws. `dropTarget` also supports `sticky` (stay the active target after the pointer leaves) and `dropEffect` (`'move' | 'copy' | 'link'`), both pragmatic element-adapter features.

## fileDropTarget (external / files)

Accept files dragged from outside the browser (pragmatic's external adapter):

```ts
import { fileDropTarget } from '@mmstack/dnd';

protected readonly drop = fileDropTarget({
  onDrop: ({ files }) => this.upload(files), // files: File[]
  // canDrop: ({ types }) => ...,  disabled, sticky, dropEffect
});
// drop.isDragOver(), drop.isInnermost()
```

`monitorExternal({ onDrop })` observes external drags globally. An element can be both an element target and a file target: apply both composables.

## monitor

```ts
protected readonly monitor = monitor<Card>({ accepts: isCard });
// monitor.isDragging(), monitor.source()
```

`isDragging` and `source` are pure derivations of the ambient session. Pass `onDragStart` or `onDrop` to also attach a thin subscription for side effects.

## Plugins

Optional `@atlaskit/*` sub-libraries are wired in structurally, so they stay out of `peerDependencies`. Register defaults once with `provideDnd`; per-call options take precedence.

```ts
import { provideDnd } from '@mmstack/dnd';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

bootstrapApplication(App, {
  providers: [
    provideDnd({
      plugins: {
        hitbox: { attachClosestEdge, extractClosestEdge },
        autoScroll: autoScrollForElements,
      },
    }),
  ],
});
```

Resolution order is per-call option, then `provideDnd` default, then off. Without a plugin, edge-dependent features are unavailable, and an explicit `edges` request throws an actionable error.

### Screen-reader announcements

`injectAnnounce()` returns the active announcer: a registered `announce` plugin if you provided one, otherwise a built-in announcer (a shared polite and assertive ARIA live region, zero dependencies). Swap in Atlassian's `@atlaskit/pragmatic-drag-and-drop-live-region` or your own:

```ts
provideDnd({ plugins: { announce: liveRegionAnnounce } });
// in a component: injectAnnounce()('Card moved to position 2 of 5');
```

## Scoping a session

The drag session is `providedIn: 'root'`, so the library works with zero configuration. To give an independent surface its own session and coordinate space, add `provideDndSession()` to a component's `providers`; the `injectDnd*` helpers then resolve to that scoped session within its subtree:

```ts
@Component({ providers: [provideDndSession()] /* ... */ })
export class BoardComponent {}
```

## Custom drag previews

```ts
draggable<Card>({
  data: this.card,
  preview: () => ({
    template: this.previewTpl(),
    context: this.card(),
    offset: 'pointer-outside',
  }),
});
```

Pass `{ component, bindings?, offset? }` (bindings via `inputBinding` / `outputBinding` / `twoWayBinding` from `@angular/core`), `{ template, context?, offset? }`, or `{ render, offset? }` (a raw escape hatch). `offset` is `'pointer-outside'` or `{ x, y }`.

## Drag metadata (`meta`)

Both `draggable()` and `dropTarget()` carry a typed `meta` payload alongside `data`, keyed by symbols so it never collides with consumer data. It is the seam that higher-level patterns build on.

```ts
const KIND = Symbol('kind');
draggable<Card, { [KIND]: 'todo' | 'done' }>({
  data,
  meta: () => ({ [KIND]: 'todo' }),
});
dropTarget<Card, void, { [KIND]: 'todo' | 'done' }>({
  accepts: isCard,
  canDrop: ({ source: { meta } }) => meta[KIND] === 'todo',
});
```

## Recipes

Render an Angular component or template as the drag image:

```ts
draggable<Card>({
  data: card,
  preview: () => ({
    template: tpl(),
    context: card(),
    offset: 'pointer-outside',
  }),
});
```

Accept only certain payloads:

```ts
dropTarget<Card>({
  accepts: isCard,
  canDrop: ({ source }) => source.data.status !== 'archived',
});
```

Upload files on drop:

```ts
fileDropTarget({
  canDrop: ({ types }) => types.includes('Files'),
  onDrop: ({ files }) => upload(files),
});
```

## Testing

Because per-element state is derived from the ambient session, most behaviour is unit-testable by setting the session and asserting the derived signals, with no drag simulation. `injectDndSession()` returns the writable session signal:

```ts
const session = TestBed.runInInjectionContext(() => injectDndSession());
session.set({
  sourceEl,
  sourceData: boxData(card),
  targets: [{ element: el, data: {} }],
  pointer: { x: 0, y: 0 },
  kind: 'transfer',
});
expect(zone.isDragOver()).toBe(true);
```

## SSR

All composables short-circuit on the server and return inert signals (`dragging` and `isDragOver` stay false); the session attaches no listeners.

## Credits

`@mmstack/dnd` is an unofficial, signals-first Angular wrapper for [pragmatic-drag-and-drop](https://github.com/atlassian/pragmatic-drag-and-drop) by Atlassian (Apache-2.0), which is required as a peer dependency and does the underlying drag-and-drop work. This project is not affiliated with or endorsed by Atlassian. The optional `@atlaskit/*` packages (hitbox, auto-scroll, flourish, live-region) plug in through `provideDnd` and remain the property of their authors.

## License

MIT © [Miha Mulec](https://github.com/mihajm)
