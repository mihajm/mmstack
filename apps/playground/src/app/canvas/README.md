# @mmstack/dnd — canvas

The pointer engine for Retool/Squarespace-style builders: free positioning,
resize, marquee selection, multi-select and pan/zoom. Built on native **Pointer
Events** (via the `pointerDrag` sensor in `@mmstack/primitives`), **not** native
HTML5 drag — so gestures fire continuously, coordinates are reliable, and there's
no frozen drag image. Ships from `@mmstack/dnd` today (future `@mmstack/dnd/canvas`).

You own the geometry signals; each gesture writes the next value into them
(snapped / clamped). All composables are SSR-safe and follow the cursor every
frame (they read the gesture's unthrottled view).

## `movable`

```ts
import { movable } from '@mmstack/dnd';

const pos = signal({ x: 40, y: 40 });

@Component({
  host: { '[style.transform]': '"translate(" + pos().x + "px," + pos().y + "px)"' },
})
export class Widget {
  protected readonly pos = pos;
  protected readonly drag = movable(this.pos, {
    grid: { size: 8 },                                   // Ctrl bypasses snapping
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    size: () => this.size(),                             // enables alignment + containment
    snapTargets: () => this.siblingBoxes(),             // Figma-style snaplines
    snapToCanvas: true,                                  // also snap to bounds edges
    group: () => this.otherSelected(),                  // group move (same delta)
    scroll: this.viewportEl,                             // auto-scroll near edges
    keyboard: true,                                      // arrow nudge (Ctrl/Cmd = ×10)
    // handle, activationThreshold, lockAxisOnShift (default true → Shift locks axis)
    // onMoveStart / onMove / onMoveEnd
  });
  // drag.moving() · drag.position() · drag.guides()  ← render the active snaplines
}
```

**Figma/Squarespace-grade behaviours, all built in:** Shift locks to the dominant
axis; `snapTargets` + `size` produce live **alignment guides** (`drag.guides()` —
render them); `group` moves the rest of a selection by the same delta; `scroll`
auto-scrolls a container when you drag near its edges; `keyboard` nudges by the
grid step (Ctrl/Cmd = large step) when the host is focused.

## `resizeHandle`

Each handle element is its own gesture host (the honest model for Pointer
Events). Render up to eight, one `resizeHandle(box, direction)` each:

```ts
const box = signal({ x: 0, y: 0, width: 120, height: 80 });

// on the bottom-right handle element:
protected readonly se = resizeHandle(box, 'se', {
  min: { width: 40, height: 24 },
  // max, grid, bounds, disabled, activationThreshold
});
// se.resizing() · se.box()
```

`applyResize(base, direction, delta, cfg)` is exported as a pure helper if you
want to compute box geometry yourself.

## `rotatable`

Rotate by dragging a handle around a pivot (Shift / `snapAlways` snaps to
increments). You own the `angle` (degrees); apply it via `transform: rotate(...)`.

```ts
const angle = signal(0);

// on the rotate-handle element:
protected readonly rot = rotatable(angle, {
  center: () => centerOf(widgetEl),   // client-space pivot
  snap: 15,                           // Shift = 15° steps
});
// rot.rotating() · rot.angle()
```

Directive form: `<div [mmRotateHandle]="angle" [center]="centerFn" [snap]="15">`.

## `marquee` + `selection`

`marquee` is **pure derivation** (no effects): give it the items' boxes (in
host-local coordinates) and it yields the live rubber-band rect and the
intersecting values. `selection` holds the committed multi-select state.

```ts
const sel = selection<number>();                 // sel.ids() · sel.has(id) · toggle/set/clear

protected readonly band = marquee(this.items);   // items: Signal<{ id, box, value }[]>
// band.selecting() · band.rect() · band.selected()
// commit on release, e.g. effect(() => { if (!band.selecting()) sel.set(lastSelected); });
```

Group-move falls out of composition: have `movable`'s `onMove` apply the same
delta to every widget whose id is in `sel.ids()`.

## `panZoom`

Pan (middle button by default) + wheel-zoom around the cursor, with projections
between viewport and canvas space:

```ts
protected readonly view = panZoom(/* viewport? defaults to host */, {
  // panButtons: [1], wheelZoom: true, minScale: 0.1, maxScale: 8
});
// view.transform() → { x, y, scale }   · view.panning()
// view.toCanvas(clientPt) · view.toViewport(canvasPt) · view.reset()
```

Apply `view.transform()` to a wrapper layer
(`translate(x,y) scale(s)`); use `toCanvas` to hit-test pointer positions and to
give nested canvases their own coordinate space.

## Grid layout / collision reflow

A separate **occupancy-grid** model (Retool/react-grid-layout style) for when
widgets should push each other to make room rather than overlap freely. Pure
engine + a reactive wrapper; drive `move` from a `movable` gesture (pixel →
cell).

```ts
import { gridLayout, type GridItem } from '@mmstack/dnd';

type Tile = GridItem & { label: string };          // GridItem = { id, x, y, w, h } in cells
const items = signal<Tile[]>([...]);
const grid = gridLayout(items, { cols: 6 });        // keeps the layout collision-free + compacted
// grid.items() · grid.rows() · grid.move(id, col, row) · grid.add(item) · grid.remove(id)

// inside a tile (movable gives free pixel drag):
movable(pos, { onMove: ({ position }) =>
  grid.move(tile.id, Math.round(position.x / CELL), Math.round(position.y / CELL)) });
```

`move` pushes colliding items down (cascading) then compacts upward, keeping the
dragged item where you dropped it. Pure helpers `moveGridItem`, `compactGrid`,
`gridCollides` are exported and type-preserving (`<T extends GridItem>`).

### Custom reflow — render from a derived position (no effect!)

`gridLayout`'s `move`/`add`/`remove` read their backing signal **untracked**, so
they're safe to call from anywhere — including `movable`'s `onMove`, which runs
inside the gesture effect. (A reactive setter that *reads then writes its own
signal while tracked* would make its caller depend on that signal and
infinite-loop; the primitive absorbs this for you. If you write your own such
helper, wrap the read in `untracked`.)

When the *rendered* position differs from `movable`'s source signal (the grid
cell renders from a derived `cellPx`, but the drag should start there), pass
`from`:

```ts
const pos = signal<Point>({ x: 0, y: 0 });             // movable writes this while dragging
const cellPx = computed(() => toPixels(item().x, item().y));
const ref = movable(pos, {
  from: () => untracked(cellPx),                        // gesture starts at the rendered cell
  onMove: ({ position }) => grid.move(item().id, toCell(position)),
});
// render: ref.moving() ? pos() : cellPx()   ← a pure computed, no effect
```

This is exactly how the `/grid` playground example reflows tiles — effect-free.

## Accessibility

Keyboard moves/resizes/reorders are built in (see `keyboard` options). For
screen-reader feedback, inject the shared `DndAnnouncer` and narrate operations
from the lifecycle callbacks:

```ts
import { DndAnnouncer } from '@mmstack/dnd';

const announcer = inject(DndAnnouncer);
movable(pos, { keyboard: true, onMoveEnd: ({ position }) =>
  announcer.announce(`Moved to ${position.x}, ${position.y}`) });
// announcer.announce(msg, 'assertive') for urgent messages (deletes, errors)
```

It manages one polite + one assertive ARIA live region (SSR-safe). Pair it with
`role`/`aria-label` on your widgets and `tabindex` for full keyboard operability.

## Geometry helpers (pure, exported)

`snapToGrid(point, grid)`, `normalizeRect(a, b)`, `intersects(a, b)`,
`clamp(v, min, max)`, `clampPoint(p, bounds)`, `clampBox(box, bounds)` — plus the
`Point` / `Box` / `GridSpec` types.
