# @mmstack/dnd

Signals-first drag & drop for Angular. Make any element draggable or a drop target with a **typed payload**, read every bit of drag state as a `Signal`, and build reorderable lists — single or cross-list — on the same primitives. Choose the engine per element: **native** HTML5 (files, cross-window, a drop-indicator line) or a first-party **pointer / FLIP** engine (siblings glide to open a gap, no browser drag image). Accessible by default, tree-shakeable, and it works with zero configuration.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/dnd/LICENSE)

Built on [@atlaskit/pragmatic-drag-and-drop](https://www.npmjs.com/package/@atlaskit/pragmatic-drag-and-drop) (v2) for the native engine; the pointer engine, sortable/FLIP, keyboard a11y, and the optional plugins are all first-party.

## Highlights

- **One reactive session.** Every per-element signal (`dragging`, `isDragOver`, `closestEdge`, …) is a `computed` off a single ambient session — no per-element writable signals, no callbacks writing into state, no effects copying signals. The core path has no recurring effects.
- **Two engines, one API.** `native` uses HTML5 DnD (files, cross-window, the browser's drag image); `pointer` uses pointer events with FLIP (buttery same-page sorting, custom followers). Both feed the same session, so `monitor`, `dragging`, and `isDragOver` behave identically. Pick per element or set a default once.
- **Sorting that doesn't fight Angular.** Reordering is a single splice on **your** `WritableSignal<T[]>` at drop — no parallel order state, the array untouched mid-drag. The pointer engine animates from derived state (FLIP) instead of mutating the DOM.
- **Cross-list & nested.** Share one `sortableGroup<T>()` and items drag between lists; innermost wins for nested lists, with a `canReceive` guard.
- **Accessible out of the box.** Focus + arrow-key reordering and screen-reader announcements are on by default (opt-out or fully replaceable).
- **Zero required plugins.** Edge detection and auto-scroll are opt-in — use the first-party **zero-dependency** plugins from the secondary entry point `@mmstack/dnd/plugins`, or plug in pragmatic's sub-libraries. Missing a plugin degrades gracefully (dev warning + no-op), never a throw.
- **Typed everywhere.** `accepts` narrows payloads with no casting; a symbol-keyed `meta` channel never collides with your data; engine-only options are compile-time-guarded per engine.
- **Composable or declarative.** Every primitive is a plain function; every directive is a thin wrapper over it. And every option is DI-defaultable.

## Installation

```bash
npm install @mmstack/dnd @atlaskit/pragmatic-drag-and-drop
```

`@atlaskit/pragmatic-drag-and-drop` is a peer dependency (it powers the native engine and the shared global monitor). The **optional** sub-libraries below are _not_ peers — reach for them only if you prefer them over the first-party plugins (see [Plugins](#plugins)):

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
    :host {
      display: flex;
      gap: 1rem;
      font-family: system-ui, sans-serif;
    }
    section {
      flex: 1;
      min-height: 120px;
      padding: 0.75rem;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }
    section.over {
      border-color: #2563eb;
      background: #eff6ff;
    }
    h3 {
      margin: 0 0 0.5rem;
      text-transform: capitalize;
    }
    article {
      margin-bottom: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      cursor: grab;
      user-select: none;
    }
    article.dragging {
      opacity: 0.4;
    }
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
- `reorderable(signal, opts)` / `injectReorderable(signal, opts)` + `Reorderable` / `ReorderableItem` (/ `ReorderableHandle`): a sortable list over your own `WritableSignal<T[]>`. See [Sortable lists](#sortable-lists-reorderable).
- `sortableGroup<T>()`: share one group object across lists so items drag between them; `DropIndicator`: the native engine's insertion line.
- `DragHandle` (`mmDragHandle`): restrict drag initiation to a child element.
- `autoScroll(opts)` / `mmAutoScroll`: edge auto-scroll (needs an auto-scroll plugin).
- `provideDnd(config)`: register optional plugins and scope a session.
- `provideDndDefaults` / `provideDraggableDefaults` / `provideDropTargetDefaults` / `provideReorderableDefaults`: set option defaults via DI. See [Defaults](#defaults).
- Custom drag previews via the `preview` option on `draggable()`.

Both `draggable` and `dropTarget` take an `engine?: 'native' | 'pointer'` (default `'native'`). Native uses HTML5 drag-and-drop (files, cross-window, the browser's drag image); pointer uses pointer events (continuous position, no native drag image — you move the element, e.g. FLIP). Both feed the same session, so `dragging` / `isDragOver` / `monitor` work identically regardless of engine.

Every composable is a function. Every directive is a thin wrapper that forwards inputs into the composable and exposes its signal state.

## The reactive model

`monitorForElements` already broadcasts the full drag world on every move. A root `DndSession` captures it once into a signal, and everything per-element is a `computed`:

```ts
// inside dropTarget()
const isDragOver = computed(() => hitIndex() >= 0);
const closestEdge = computed(() => /* read from the session via the hitbox plugin */);
```

_There are no per-element writable signals, no callbacks writing into signals, and no effects copying one signal into another. Pragmatic's config hooks (`getInitialData`, `canDrop`, `getData`) are read lazily, so registration happens once. A reactive `dragHandle` is the only thing that re-registers, and only when the handle element changes._

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

`closestEdge` and `edges` need the hitbox plugin (see [Plugins](#plugins)); without it, drops still work — you just get no edge (`closestEdge()` stays `null`), plus a one-time dev warning. `dropTarget` also supports `sticky` (stay the active target after the pointer leaves) and `dropEffect` (`'move' | 'copy' | 'link'`), both pragmatic element-adapter features.

Both `draggable` and `dropTarget` accept `engine: 'pointer'` to drive via pointer events instead of native HTML5 DnD (see [Sortable lists](#sortable-lists-reorderable) for the engine trade-offs). In pointer mode `draggable` moves the element itself (there's no browser drag image), so `preview` renders a floating follower; native `preview` uses the browser's custom drag preview. The `engine` is resolved at creation. `edges` / `sticky` / `dropEffect` are native-only and are compile-time-forbidden when `engine: 'pointer'`; conversely `activationThreshold` (px before the drag activates, default 5) is pointer-only.

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

## Sortable lists (`reorderable`)

`reorderable` turns your own `WritableSignal<T[]>` into a sortable list. Reordering is a single splice on your signal at drop — there's no parallel order state, and the array is untouched mid-drag. Bind the returned controller to the `mmReorderable` container + `mmReorderableItem` directives:

```ts
import { Component, signal } from '@angular/core';
import { Reorderable, ReorderableItem, reorderable } from '@mmstack/dnd';

type Task = { id: number; label: string };

@Component({
  selector: 'app-list',
  imports: [Reorderable, ReorderableItem],
  template: `
    <ul [mmReorderable]="list">
      @for (task of list.items(); track task.id) {
        <li [mmReorderableItem]="task">{{ task.label }}</li>
      }
    </ul>
  `,
})
export class ListComponent {
  private readonly tasks = signal<Task[]>([
    { id: 1, label: 'One' },
    { id: 2, label: 'Two' },
    { id: 3, label: 'Three' },
  ]);
  protected readonly list = reorderable(this.tasks, { key: (t) => t.id });
}
```

> **`reorderable` vs `injectReorderable`.** `reorderable` is a pure factory (no DI — great for tests). Use `injectReorderable` (same signature, called from an injection context) when you want the list to pick up DI option [defaults](#defaults) — it captures the current `Injector` and hands it to `reorderable` for you.

Keyboard reordering is on by default: focus a row, then arrow keys move it one step (axis-aware), and `Cmd`/`Ctrl` + arrow jumps to an end — announced via [`injectAnnounce`](#screen-reader-announcements), and the moved row is kept focused and scrolled into view. Every piece is opt-out or replaceable:

```ts
reorderable(this.items, {
  key: (t) => t.id,
  keyboard: false, // ← disable keys entirely (no tabindex, no handler)
  announceMove: false, // ← silence announcements (no live region is created)
  jumpModifier: (e) => e.shiftKey, // ← Shift instead of Cmd/Ctrl for the built-in jump

  // …or take over keydown completely (custom keys / behaviour). `api.move(to)`
  // reuses the built-in commit + announce + focus-restore; ignore it to do your own thing.
  onKeyboardKeydown: (e, { index, total, move }) => {
    if (e.key === 'j') {
      e.preventDefault();
      move(Math.min(index + 1, total - 1));
    }
    if (e.key === 'k') {
      e.preventDefault();
      move(Math.max(index - 1, 0));
    }
  },
});
```

### Engines: `native` (indicator) vs `pointer` (FLIP)

Same API, two render/drag models, chosen with `engine` (default `'native'`):

- **`'native'`** — HTML5 drag-and-drop. Items stay put and a `DropIndicator` line shows where the drop will land. Composes with file / cross-window drags.
- **`'pointer'`** — pointer events. Siblings glide (FLIP) to open a gap and the dragged element follows the pointer; the "gap" placeholder feel. In-page only.

```ts
reorderable(this.tasks, { key: (t) => t.id }); // native indicator (default)
reorderable(this.tasks, { key: (t) => t.id, engine: 'pointer' }); // FLIP glide
```

The item is `position: relative` in both engines so the native indicator can overlay; opt into the reserved gap space (pointer engine, cross-list) with `padding-bottom: calc(<your> + var(--mm-sortable-reserved, 0px))` on the container.

**Escape cancels in both engines.** Pressing Escape (or a `pointercancel`, e.g. a touch scroll takeover) aborts the drag without committing — items glide back and nothing is spliced. Only a real release commits. The controller also exposes `cancel()` for a programmatic abort.

### Cross-list

Give two (or more) lists the **same** `sortableGroup<T>()` object and items drag between them:

```ts
import { reorderable, sortableGroup } from '@mmstack/dnd';

private readonly board = sortableGroup<Task>();
protected readonly todo = reorderable(this.todoItems, { key: (t) => t.id, group: this.board });
protected readonly done = reorderable(this.doneItems, { key: (t) => t.id, group: this.board });
```

`onItemLeft` fires on the source, `onItemArrived` on the target. For nested lists (a list inside another list's item), the innermost list wins; a `canReceive: (item) => boolean` guard rejects invalid drops — e.g. a tree node dropped into its own subtree.

### External / palette insert

Accept a payload dragged from **outside** any list (e.g. a palette `draggable`) and map it to a list item (native engine):

```ts
reorderable(this.items, {
  key: (t) => t.id,
  insert: {
    accepts: (d): d is Chip => isChip(d),
    create: (chip, index) => ({ id: nextId(), label: chip.kind }),
  },
  onItemInserted: ({ item, index }) => save(item, index),
});
```

### Options

`key` (required identity), `engine`, `axis` (`'y'` \| `'x'`), `deadband` (px a center must be cleared before the insert flips), `activationThreshold` (px before a drag activates — pointer engine), `group`, `keyboard` (or `false`), `jumpModifier`, `onKeyboardKeydown` (own the keys), `announceMove` (custom message or `false` to silence), `animation` (FLIP-on-commit / pointer glide, or `false`), `autoScroll` (opt-in `{ edge, speed, edgeProportion?, maxSpeedAt? }` — needs an auto-scroll plugin, see below), `canReceive` (cross-list drop guard), `insert` (foreign-payload mapping, native engine), and the callbacks `onReorder` / `onItemLeft` / `onItemArrived` / `onItemInserted`.

## Plugins

Edge-aware drops (`hitbox`) and auto-scroll are **opt-in plugins**, registered once via `provideDnd` (per-call options take precedence). You can use our **zero-dependency** first-party plugins from `@mmstack/dnd/plugins` (no `@atlaskit/*` needed — great for pointer-only apps), or plug in the pragmatic sub-libraries:

```ts
import { provideDnd } from '@mmstack/dnd';
// first-party, zero-dep (unused ones tree-shake away):
import { edgeAutoScroll, closestEdge } from '@mmstack/dnd/plugins';

bootstrapApplication(App, {
  providers: [
    provideDnd({
      plugins: {
        hitbox: closestEdge, // …or pragmatic's { attachClosestEdge, extractClosestEdge }
        autoScroll: edgeAutoScroll, // …or pragmatic's autoScrollForElements
      },
    }),
  ],
});
```

Resolution order is per-call option → `provideDnd` default → none. Without a plugin, the dependent feature (edge detection, auto-scroll) **degrades gracefully**: a one-time dev-mode warning naming the plugin, then a no-op (never a throw).

> **Auto-scroll note.** `edgeAutoScroll` is engine-agnostic (drives both the pointer and native reorderable engines) and needs no pragmatic sub-package. Pragmatic's `autoScrollForElements` is monitor-driven, so it only serves the **native** engine — use `edgeAutoScroll` for the pointer engine.

### Screen-reader announcements

`injectAnnounce()` returns the active announcer: a registered `announce` plugin if you provided one, otherwise a built-in announcer (a shared polite and assertive ARIA live region, zero dependencies). Swap in Atlassian's `@atlaskit/pragmatic-drag-and-drop-live-region` or your own:

```ts
provideDnd({ plugins: { announce: liveRegionAnnounce } });
// in a component: injectAnnounce()('Card moved to position 2 of 5');
```

## Defaults

Set option defaults once via DI instead of repeating them at every call. The canonical example is `engine` — flip your whole app to the pointer engine in one line:

```ts
import { provideDndDefaults } from '@mmstack/dnd';

bootstrapApplication(App, {
  providers: [provideDndDefaults({ engine: 'pointer' })], // every primitive → pointer
});
```

`provideDndDefaults` holds the **cross-primitive** defaults (currently `engine`). Each primitive also has its own provider for options only it understands, and it **inherits** the common defaults unless it sets that key itself:

```ts
import {
  provideDraggableDefaults,
  provideDropTargetDefaults,
  provideReorderableDefaults,
} from '@mmstack/dnd';

provideReorderableDefaults({ axis: 'x', animation: { duration: 150 } });
provideDropTargetDefaults({ sticky: true, dropEffect: 'copy' });
provideDraggableDefaults({ engine: 'native' }); // e.g. keep draggables native while lists go pointer
```

Every field is optional — provide just the one you care about. Resolution order, most-specific first:

**per-call option → per-primitive default → common (`provideDndDefaults`) → built-in.**

> One sharp edge: the engine-specific options are compile-time-guarded **per call**, but a DI default can flip the engine underneath a call site that omitted it. A native-only option (e.g. `insert`) is then silently ignored — `reorderable` warns about this in dev mode. Pin `engine` at the call site (or per-primitive default) where you rely on engine-specific options.

Each provider accepts a value **or a factory** (`T | (() => T)`), matching `provideDnd`. Each token also has a matching reader — `injectDndDefaults`, `injectDraggableDefaults`, `injectDropTargetDefaults`, `injectReorderableDefaults` — returning the resolved defaults (or `null`); pass an `Injector` to read them outside an injection context.

The directives and the `draggable` / `dropTarget` composables pick defaults up automatically. For a reorderable list, use **`injectReorderable`** (the DI-aware wrapper) so the list resolves defaults; the pure `reorderable` reads no DI:

```ts
import { injectReorderable } from '@mmstack/dnd';

protected readonly list = injectReorderable(this.tasks, { key: (t) => t.id });
// picks up provideDndDefaults / provideReorderableDefaults; a per-call option still wins.
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
  engine: 'native', // default already, just explicit for docs
});
expect(zone.isDragOver()).toBe(true);
```

Reorderable logic is testable without a DOM: `reorderable(signal, opts)` is a pure controller — drive `begin` / `move` / `end` and read the per-item state signals directly.

## SSR

All composables short-circuit on the server and return inert signals (`dragging` and `isDragOver` stay false); the session attaches no listeners.

## Credits

`@mmstack/dnd` is an unofficial, signals-first Angular DnD library. Its **native** engine builds on [pragmatic-drag-and-drop](https://github.com/atlassian/pragmatic-drag-and-drop) by Atlassian (Apache-2.0) — required as a peer dependency — which does the underlying HTML5 drag-and-drop work and provides the shared global monitor. This project is not affiliated with or endorsed by Atlassian. The optional `@atlaskit/*` packages (hitbox, auto-scroll, flourish, live-region) plug in through `provideDnd` and remain the property of their authors; the pointer engine, sortable/FLIP, keyboard a11y, and the first-party `@mmstack/dnd/plugins` are original work.

## License

MIT © [Miha Mulec](https://github.com/mihajm)
