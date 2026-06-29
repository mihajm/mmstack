# `placeholder: 'gap'` — design notes & plan

Status: **opt-in / experimental.** The default `placeholder: 'indicator'` (a single
folded line) is the polished, shipping mode. Gap mode (a SortableJS-style moving
gap that opens where the item will land) works for mid-list drops but is **finicky
at the top / second positions** and is not yet flagship-grade. This doc captures
where we landed and what it'll take to finish, so it's not re-derived from scratch.

## Goal
When dragging, open a gap the size of the dragged item at the drop position (and
remove it from its old spot), so the list visibly "makes room" — the SortableJS /
dnd-kit feel — instead of drawing a line.

## Where we landed (current implementation)
- **Net-zero layout:** the source is `display:none` (removed from flow) and an
  equal-sized gap (`margin-block`/`inline`) opens at the insert index, so total
  list height stays constant (no growth-driven shake).
- **Insert index via collision:** `Reorderable.activeInsert` = pointer-vs-item
  **centers cached at drag start** (`insertIndexFromCenters`). Cached = stable, so
  the opening gap can't feed back. The gap renders *before* the insert item, or
  *after* the last item for end-of-list (mirrors the indicator fold).
- **Drop commits at the same collision index** (`_lastInsert`/`_insertTarget`), so
  the gap and the drop never disagree.
- A demo CSS `transition: margin` makes the gap glide.

This is smooth and correct **in the middle of the list**.

## Why it's finicky at the top / second (root cause)
Removing the source from flow (`display:none`) **shifts every item below it up by
the source's height.** But the collision uses centers **measured with the source
still present**. So once the source is hidden, the cached centers no longer match
where items actually are — and the error is **worst when you drag a top item**,
because removing a top item shifts almost the whole list. That's the finickiness.

Second, opening the gap *also* shifts items, and that shift depends on the insert
index, which depends on the collision, which depends on the shift — **circular.**
Cached centers keep it stable (no shake) but describe the *pre-move* layout, not
what you see, so the pointer↔item mapping is off by ~one item near the active gap.

This is fundamental: **a moving gap means items aren't where the cached centers
say.** Accurate collision then requires *transform-aware* hit-testing. It's exactly
why pragmatic / Trello / our default use a **line** — the line moves nothing, so
cached centers always match reality and collision is exact.

## What to explore to finish it
The correct model is **transform-based sortable** (how dnd-kit does it):

1. **Keep the source in flow** (its slot preserved) and hide it visually
   (`opacity:0`). Layout flow never changes → **cached centers stay valid.**
2. **Shift siblings with `transform: translate`** (not margin) to open the gap at
   the insert position and close the source's old slot. Transforms don't affect
   layout flow, so they don't invalidate the cached centers.
3. **Transform-aware collision:** test the pointer against `cachedCenter +
   currentTransform` for each item (no re-measure → no feedback, but accurate).
   Resolve the circularity with hysteresis (use the previous frame's transforms,
   or a deadband) the way dnd-kit does.
4. **Shift math:** items between the source's slot `S` and the insert `J` translate
   by the source size; handle up-vs-down and **variable item heights** (shift by
   the source's own size, not an assumed uniform height).
5. **Index mapping:** with the source kept in flow, array indices stay stable
   (no visible-slot vs array-index juggling — that juggling is the off-by-one trap
   if you instead remove the source).

### Alternative: adopt `@dnd-kit/dom` for the in-page engine
The transform sortable + transform-aware collision is a real subsystem. The new
`@dnd-kit/abstract` + `@dnd-kit/dom` (framework-agnostic) gives it for free, with a
mature collision/sensor/animation core. If we move the in-page engine (sortable +
canvas) to a pointer base, gap mode comes along for free. Caveats: it's pre-1.0 /
single-maintainer, and we'd keep pragmatic for native file/cross-window transfer
regardless. See the architecture notes in the memory.

## Decision
Ship the **line** as the polished default. Keep gap **opt-in/experimental** in this
app-internal sortable. Finish it properly (transform-aware) — or inherit it via a
pointer-engine adoption — when it's prioritized, not by nudging cached numbers.

## Pointers
- `reorderable.ts`: `activeInsert` (collision), `_centers`/`insertIndexFromCenters`,
  `_lineOffset` (centered line), the gap `effect` (display:none + margins),
  `_setDraggedSize`/`gapSize`.
- The indicator fold (default mode) is the reference for "one stable insertion
  point" — gap mode should converge on the same insert index, just rendered as a
  gap instead of a line.
