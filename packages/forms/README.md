# @mmstack/forms

**Composable utilities for Angular Signal Forms — typed field metadata, field-type compositions, and change tracking / reconciliation.**

[![npm version](https://badge.fury.io/js/%40mmstack%2Fforms.svg)](https://badge.fury.io/js/%40mmstack%2Fforms)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/packages/forms/LICENSE)

`@mmstack/forms` is **not** a forms framework. It's a small toolbox layered on top of the stable
`@angular/forms/signals` API (Angular 22+). Signal Forms already own the model, the field tree, and
validation; this library fills the ergonomic gaps around them — attaching typed metadata to fields,
composing reusable "field types," and tracking what changed for dirty-diffs and server reconciliation
— without a parallel form system. You compose the pieces; you keep full control.

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

## Field metadata

Signal Forms ships a generic metadata system (`createMetadataKey` + `metadata()` rule +
`FieldState.metadata()`), but it's verbose and the read path is non-obvious. `fieldMetadata` bundles
the three layers into one typed `[rule, reader]` pair that looks and feels like the native rules.

```typescript
import { fieldMetadata } from '@mmstack/forms';

export const [withLabel, injectLabel] = fieldMetadata<string>({ debugName: 'label' });
```

Set it in a schema (just like `required` / `min`), read it inside a control (just like `input()`):

```typescript
const f = form(model, (p) => {
  required(p.name);
  withLabel(p.name, 'Full name'); // static value, or a reactive LogicFn
});

@Component({ /* a control on a [formField] host */ })
class TextField {
  readonly label = injectLabel('(unlabeled)'); // Signal<string>
}
```

Resolution precedence at read time: **value set in the schema → component fallback (`injectLabel(x)`) →
base fallback (`fieldMetadata({ fallback })`) → `undefined`**. The reader's type reflects it —
`Signal<T>` when a fallback is guaranteed, `Signal<T | undefined>` otherwise.

A built-in `label` is deliberately not shipped — define the attributes your app needs.

> The reader must run in an injection context **on (or under) a `[formField]` host** — it resolves
> via the `FORM_FIELD` token that the `FormField` directive provides. To read field state from a
> sibling/wrapper directive, inject the token; **do not** declare your own `formField` input — that
> trips the directive's pass-through and silently breaks the native value binding.

## Composition

The composable unit is a **projector** — a pure function from the (once-injected) field handle to a
value. `compose` injects the field a single time and materializes a record of projectors into one
object of signals, so you can author reusable field types.

```typescript
import { compose, type FieldRef } from '@mmstack/forms';

// projectors read field state lazily — return a value, a getter, or a signal
const firstError = (f: FieldRef) => () => f.state().errors()[0]?.message ?? '';

@Component({ /* control */ })
class TextField {
  readonly field = compose({
    label: withLabel, // a fieldMetadata rule carries its own projector
    error: firstError,
    invalid: (f: FieldRef) => () => f.state().invalid(),
  });
  // template: {{ field.label() }} / {{ field.error() }}
}
```

Projector returns are normalized to signals: a `Signal` is used as-is, a getter `() => T` is wrapped
in `computed`, a plain value becomes a constant signal.

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
  options: (f: FieldRef) => () => f.state().metadata(OPTIONS)?.() ?? [],
});

// in a control:
readonly field = injectSelect(); // { label, error, options } — one inject(FORM_FIELD)
```

`injectField(projector)` materializes a single projector, and `raw(value)` marks a projected value to
bypass signal-normalization (used for methods like `reset` / `reconcile`, below).

## Change tracking

Native `dirty` tracks whether a field was *interacted with*. Change tracking adds **`changed`** — does
the field's value differ from a *baseline* — which is what you want for dirty-diffs, "unsaved changes"
guards, and server reconciliation. It mirrors the delegation of the original `@mmstack/form-core`:
leaves compare against their own baseline, containers aggregate, with an `Object.is` short-circuit so a
change only walks its own spine.

```typescript
import { trackChanges, commitChanges, injectChanged } from '@mmstack/forms';

@Component({ /* ... */ })
class Editor {
  readonly model = signal<User>(emptyUser());
  readonly f = form(this.model, trackChanges(this.model));

  constructor() {
    // Establish the baseline once the initial data is in place.
    commitChanges(this.f);
  }
}

// any control:
readonly changed = injectChanged(); // Signal<boolean> for this field
```

> **`commitChanges` defines the baseline.** Per-field baselines are captured eagerly when you call it
> (not at control mount — that would be too early for async-loaded data). Call it after the form's
> initial data is ready, and again after a successful save to mark the new "saved" state.

Default equality is `Object.is` at leaves (delegate-down for objects/arrays). Override per path:

```typescript
form(model, (p) => {
  changedEqual(p.profile.avatar, (a, b) => normalize(a) === normalize(b)); // custom equality
  changedWith(p.tags, (initial, current) => current.length !== initial.length); // fully custom
  trackChanges(model)(p);
});
```

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
leaves merge as a unit. Customize a path — e.g. a smart array merge — with `reconcileWith`:

```typescript
form(model, (p) => {
  reconcileWith(p.tags, ({ current, incoming, changed }) => (changed ? current : incoming));
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
