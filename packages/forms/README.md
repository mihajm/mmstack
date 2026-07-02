# @mmstack/forms

**Composable utilities for Angular Signal Forms — typed field metadata, field-type compositions, and change tracking / reconciliation.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Fforms.svg)](https://badge.fury.io/js/%40mmstack%2Fforms)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/forms/LICENSE)

`@mmstack/forms` is **not** a forms framework. It's a small toolbox layered on top of the stable
`@angular/forms/signals` API (Angular 22+). Signal Forms already own the model, the field tree, and
validation; this library fills the ergonomic gaps around them, like attaching typed metadata to fields,
composing reusable "field types," and tracking what changed for dirty-diffs and server reconciliation, without a parallel form system. You compose the pieces; you keep full control.

## Install

```bash
npm install @mmstack/forms
```

Peer dependencies: `@angular/core` and `@angular/forms` (`>=22 <23`).

## Contents

- [Field metadata](#field-metadata) — `fieldMetadata`
- [Composition](#composition) — `compose`, `composition`, `injectField`, `raw`, projectors
- [Change tracking](#change-tracking) — `trackChanges`, `commitChanges`, `injectChanged`, `changedEqual` / `changedWith`
- [Reset & reconcile](#reset--reconcile) — `resetChanged`, `resetInitial`, `reconcile`, `reconcileWith`
- [Composition fragments](#composition-fragments) — `changeTracking`, `reconciliation`
- [Recipes](#recipes) — unsaved-changes guard, undo/redo

## Field metadata

Signal Forms ships a generic metadata system (`createMetadataKey` + `metadata()` rule +
`FieldState.metadata()`), but it's verbose and the read path is non-obvious. `fieldMetadata` bundles
the three layers into one typed `[rule, reader, key]` tuple that looks and feels like the native rules.

```typescript
import { fieldMetadata } from '@mmstack/forms';

export const [withLabel, injectLabel, LABEL] = fieldMetadata<string>({
  debugName: 'label',
});
// destructure the key only when you need it: [withLabel, injectLabel] works as before
```

Set it in a schema (just like `required` / `min`), read it inside a control (just like `input()`):

```typescript
const f = form(model, (p) => {
  required(p.name);
  withLabel(p.name, 'Full name'); // static value, or a reactive LogicFn
});

@Component({
  /* a control on a [formField] host */
})
class TextField {
  readonly label = injectLabel('(unlabeled)'); // Signal<string>
}
```

The rule attaches to **any** field path, independent of the field's value type — a string attribute
like a label belongs on number and boolean fields too — and a reactive `LogicFn` value gets its
context typed by the field it's on:

```typescript
withLabel(p.count, ({ value }) => `${value().toFixed(0)} items`); // value() is number-typed
```

Resolution precedence at read time: **value set in the schema → component fallback (`injectLabel(x)`) →
base fallback (`fieldMetadata({ fallback })`) → `undefined`**. Only `undefined` counts as unset — a
schema-set `null` is a real value and does not fall through. The reader's type reflects it —
`Signal<T>` when a fallback is guaranteed, `Signal<T | undefined>` otherwise.

> The reader must run in an injection context **on (or under) a `[formField]` host** — it resolves
> via the `FORM_FIELD` token that the `FormField` directive provides. To read field state from a
> sibling/wrapper directive, inject the token; **do not** declare your own `formField` input — that
> trips the directive's pass-through and silently breaks the native value binding.

### The key — native-layer interop

The third tuple element is the underlying `MetadataKey`, for when you need to step outside the
sugar (mirrors `injectable`'s `[inject, provide, token]`): set the attribute through the native
`metadata()` rule, read it raw via `FieldState.metadata()`, assert it in tests, or [compose it
directly](#composition).

```typescript
import { metadata } from '@angular/forms/signals';

form(model, (p) => metadata(p.name, LABEL, () => 'Full name')); // native rule, same attribute
state().metadata(LABEL)?.(); // raw read
```

One semantic to know: the key reads the **raw accumulator** — `Signal<T | undefined>`, with **no
fallbacks applied**. Fallbacks (component and base) are reader/projector sugar, so `injectLabel()`
and `state().metadata(LABEL)?.()` can legitimately differ on an unset field.

## Composition

The composable unit is a **projector** — a pure function from the (once-injected) field handle to a
value. `compose` injects the field a single time and materializes a record of projectors into one
object of signals, so you can author reusable field types.

```typescript
import { REQUIRED } from '@angular/forms/signals';
import { compose, type FieldRef } from '@mmstack/forms';

// projectors read field state lazily — return a value, a getter, or a signal
const firstError = (f: FieldRef) => () => f.state().errors()[0]?.message ?? '';

@Component({
  /* control */
})
class TextField {
  readonly field = compose({
    label: withLabel, // a fieldMetadata rule carries its own projector
    required: REQUIRED, // a MetadataKey composes directly — Signal<boolean | undefined>
    error: firstError,
    invalid: (f: FieldRef) => () => f.state().invalid(),
  });
  // template: {{ field.label() }} / {{ field.error() }}
}
```

Projector returns are normalized to signals: a `Signal` is used as-is, a getter `() => T` is wrapped
in `computed`, a plain value becomes a constant signal. A bare `MetadataKey` (native, or the third
element of a `fieldMetadata` tuple) is sugar for [`fromMetadata(key)`](#frommetadata--surface-rule-metadata)
— no fallback; use `fromMetadata(key, fallback)` when you want one.

> **Projectors must read field state lazily** — return a getter/signal, not an eager `f.state()`
> call. `compose` runs in a control's field initializers, before the `[formField]` input is bound.
> `(f) => () => f.state().value()` ✓ — `(f) => f.state().value` ✗.

### `composition` — name a reusable field type

`composition` returns a `[fragment, inject]` tuple, mirroring `fieldMetadata`'s `[rule, reader]`.
The fragment is a plain record of projectors — spread it to extend or combine field types.

```typescript
import { composition } from '@mmstack/forms';

const [textField, injectTextField] = composition({ label: withLabel, error: firstError });
const [select, injectSelect] = composition({
  ...textField, // extend by spreading
  options: fromMetadata(OPTIONS, []),
});

// in a control:
readonly field = injectSelect(); // { label, error, options } — one inject(FORM_FIELD)
```

`injectField(projector)` materializes a single projector, and `raw(value)` marks a projected value to
bypass signal-normalization (used for methods like `reset` / `reconcile`, below).

### `fromMetadata` — surface rule metadata

The projector every field-type library ends up hand-rolling: read a metadata key — Angular's
native `REQUIRED` / `MIN` / `MAX` / …, or your own — as a composed signal. Without a fallback you
can skip it entirely and compose the key itself:

```typescript
import { MIN, REQUIRED } from '@angular/forms/signals';
import { composition, fromMetadata } from '@mmstack/forms';

const [numberField, injectNumberField] = composition({
  required: fromMetadata(REQUIRED, false), // Signal<boolean> — never undefined
  min: MIN, // bare key ≡ fromMetadata(MIN) — Signal<number | undefined>
});
// template: input [attr.aria-required]="field.required()" [attr.min]="field.min()"
```

Only `undefined` counts as unset (a schema-set `null` is a real value, same rule as
`fieldMetadata`); with a fallback the projected signal never yields `undefined`.

## Change tracking

Native `dirty` tracks whether a field was _interacted with_. Change tracking adds **`changed`** — does
the field's value differ from a _baseline_ — which is what you want for dirty-diffs, "unsaved changes"
guards, and server reconciliation. It mirrors the delegation of the original `@mmstack/form-core`:
leaves compare against their own baseline, containers aggregate, with an `Object.is` short-circuit so a
change only walks its own spine.

```typescript
import { trackChanges, injectChanged } from '@mmstack/forms';

@Component({ /* ... */ })
class Editor {
  readonly model = signal<User>(emptyUser());
  readonly f = form(this.model, trackChanges(this.model)); // baseline = the model's initial value
}

// any control:
readonly changed = injectChanged(); // Signal<boolean> for this field
```

> **The baseline is established automatically.** By default `trackChanges` adopts the model's initial
> value as the baseline (captured on the first effect flush after construction — programmatic edits
> made before then are absorbed into it), so `changed` is meaningful with no extra wiring. Two
> options tune this:
>
> `trackChanges(model, { manualCommit: true })` skips the automatic baseline and lets you call
> [`commitChanges`](#reset--reconcile) yourself — the right choice when the initial data arrives
> **asynchronously** and you want to commit it explicitly once it lands (until then every field reads
> as `changed`).
>
> You can call `commitChanges(f)` at any time to (re-)baseline to the current values — e.g. after a
> successful save (in your `submit()` action's success path) to mark the new "saved" state.

Default equality is `Object.is` at leaves (delegate-down for objects/arrays). Override per path:

```typescript
form(model, (p) => {
  changedEqual(p.profile.avatar, (a, b) => normalize(a) === normalize(b)); // custom equality
  changedWith(p.tags, (initial, current) => current.length !== initial.length); // fully custom
  trackChanges(model)(p);
});
```

> **Arrays diff their items by value, index-wise** (so reorders of identity-tracked items are still
> caught). One consequence: an override placed on an _item_ path affects that item's own `changed`
> signal, but not the array's (or any ancestor's) — put the override on the **array path itself** to
> change how the container diffs.

## Reset & reconcile

Both build on the native `FieldState.reset` (which clears touched/dirty and optionally sets the value),
so a single call handles native state and the baseline together.

```typescript
import { resetChanged, resetInitial, reconcile } from '@mmstack/forms';

resetChanged(this.f); // revert values to baseline + clear touched/dirty (cancel edits)
resetInitial(this.f, savedUser); // adopt a new value AND baseline (e.g. after save)
reconcile(this.f, serverUser); // merge server data without clobbering in-flight edits
```

`reconcile` is the headline: every field's baseline becomes the incoming value; **unchanged** fields
adopt it, **changed** fields keep the user's edit (now measured against the new baseline — so if the
server caught up to an edit, it goes back to unchanged on its own). Objects merge per-leaf; arrays and
leaves merge as a unit (item baselines still follow the incoming values, so item-level `changed` stays
consistent — a locally added item with no incoming counterpart simply reads as changed). Customize a
path — e.g. a smart array merge — with `reconcileWith`:

```typescript
form(model, (p) => {
  reconcileWith(p.tags, ({ current, incoming, changed }) =>
    changed ? current : incoming,
  );
  trackChanges(model)(p);
});
```

## Composition fragments

Spread these into a `composition` to expose change-tracking on the field object itself:

```typescript
import { changeTracking, reconciliation } from '@mmstack/forms';

const [textField, injectTextField] = composition({
  ...changeTracking<string>(), // → { changed: Signal<boolean>, reset(initial?) }
  label: withLabel,
});

const [syncedField, injectSyncedField] = composition({
  ...reconciliation<string>(), // → changeTracking + reconcile(incoming)
  label: withLabel,
});

// in a control:
readonly field = injectTextField();
// field.changed(), field.reset(), field.label()
```

`reset()` reverts to baseline; `reset(value)` adopts a new value+baseline; `reconcile(incoming)` merges.

## Recipes

Two compositions that need no new machinery — the tracked form already carries everything.

### Unsaved-changes guard

The form's `changed` signal **is** the dirty flag, so a `CanDeactivate` guard is a one-liner per route. Keep the confirm function injectable so a dialog can replace `window.confirm` later:

```typescript
import { type CanDeactivateFn } from '@angular/router';
import { CHANGED } from '@mmstack/forms';

export const unsavedChangesGuard: CanDeactivateFn<{
  form: FieldTree<unknown>;
}> = (component) =>
  !(component.form().metadata(CHANGED)?.changed() ?? false) ||
  confirm('You have unsaved changes — leave anyway?');

// route: { path: 'edit', component: EditPage, canDeactivate: [unsavedChangesGuard] }
```

A component-scoped variant reads `injectChanged()` on the component and exposes it as `hasUnsavedChanges()`. Interplay with `TransitionRouterOutlet`: guards run **before** the outlet's hold arms, so a rejected deactivation never starts a transition — no conflict, nothing to configure.

### Undo/redo

`withHistory` (from `@mmstack/primitives`) over the model signal gives undo/redo; the one rule is that history and change-tracking own **different baselines** — undo steps move the value, `commitChanges`/`resetInitial` move the comparison point, and they must not fight:

```typescript
import { withHistory } from '@mmstack/primitives';

const model = withHistory(
  { name: 'ann', tags: [] as string[] },
  { maxSize: 50 },
);
const f = form(model, trackChanges(model));

model.undo(); // steps the VALUE back — `changed` recomputes against the unmoved baseline
model.redo();

// on successful save: commit the baseline AND make the saved state the new floor
commitChanges(f);
model.clear(); // optional: saved state becomes the oldest undo step
```

Undo past the baseline correctly reports `changed: false` when it lands on the committed value — the tracker compares values, not history positions. If a save should also collapse history, `clear()` after `commitChanges` is the whole policy.
