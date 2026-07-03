import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-forms-composition',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Composition"
      pkg="@mmstack/forms"
      lead="Define a reusable field type once, as a record of projectors, and materialize it into an object of signals in each control. One inject, not one per attribute."
    >
      <docs-section title="Projectors" id="projectors">
        <p>
          Most controls read the same handful of things off their field: the
          label, the first error, whether it is invalid, whether it is required.
          Writing those reads out by hand in every control is repetitive, and
          each one injects the field again. Composition lets you declare that set
          once and reuse it.
        </p>
        <p>
          A projector is a pure function from the field handle to a value.
          <code>compose</code> injects the field once and turns a record of
          projectors into one object of signals. A <code>fieldMetadata</code>
          rule carries its own projector, and a bare <code>MetadataKey</code>
          composes directly.
        </p>
        <docs-code [code]="compose" lang="ts" />
        <p>
          Returns are normalized to signals: a signal is used as is, a getter is
          wrapped in <code>computed</code>, a plain value becomes a constant.
          Read field state lazily, returning a getter or signal, because
          <code>compose</code> runs in the control's initializers before the
          <code>[formField]</code> input is bound.
        </p>
        <docs-code [code]="lazy" lang="ts" />
      </docs-section>

      <docs-section title="Naming a field type" id="composition">
        <p>
          <code>composition</code> returns a <code>[fragment, inject]</code>
          tuple, mirroring <code>fieldMetadata</code>. The fragment is a plain
          record of projectors, so you extend one field type into another by
          spreading it.
        </p>
        <docs-code [code]="composition" lang="ts" />
      </docs-section>

      <docs-section title="fromMetadata and raw" id="helpers">
        <p>
          <code>fromMetadata</code> reads a metadata key, native
          (<code>REQUIRED</code>, <code>MIN</code>) or your own, as a composed
          signal. Without a fallback you can compose the bare key instead. With
          a fallback the projected signal never yields <code>undefined</code>.
        </p>
        <docs-code [code]="fromMetadata" lang="ts" />
        <p>
          <code>injectField(projector)</code> materializes a single projector,
          and <code>raw(value)</code> marks a projected value to skip
          signal-normalization, which is how methods like <code>reset</code>
          come through composition unchanged.
        </p>
      </docs-section>

      <docs-section title="Ready-made fragments" id="fragments">
        <p>
          Some behavior is worth shipping as a fragment so field types adopt it
          by spreading, not by re-deriving. <code>changeTracking()</code> adds a
          <code>changed</code> signal and a <code>reset</code> method:
          <code>reset()</code> reverts the field to its baseline, and
          <code>reset(initial)</code> sets a new value and adopts it as the new
          baseline. <code>reconciliation()</code> is everything from
          <code>changeTracking()</code> plus a <code>reconcile(incoming)</code>
          method that merges server data while keeping in-flight edits.
        </p>
        <docs-code [code]="fragments" lang="ts" />
        <p>
          Those methods are why <code>raw()</code> exists. A projector's return
          is normalized to a signal by default, which is right for
          <code>changed</code> but wrong for <code>reset</code> and
          <code>reconcile</code>: you want to call them, not read them through a
          signal. The fragments wrap each method in <code>raw()</code> so it
          passes through composition as the bare function. Reach for
          <code>raw()</code> yourself whenever a field type needs to expose a
          method or any other value that should not become a signal.
        </p>
      </docs-section>

      <docs-section title="The raw field handle" id="field-ref">
        <p>
          <code>injectField</code> and <code>compose</code> both build on
          <code>injectFieldRef()</code>, which resolves the
          <code>FieldRef</code> for the current <code>[formField]</code> host
          with a single injection. Most field types never call it, because a
          projector already receives the ref. Reach for it when you need the raw
          handle directly, for imperative work that does not fit the projector
          shape, for example calling a method on <code>formField</code> or
          reading state outside a composition. It throws when there is no bound
          field, and the name you pass shows up in that error.
        </p>
        <docs-code [code]="fieldRef" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class CompositionDoc {
  protected readonly compose = `import { REQUIRED } from '@angular/forms/signals';
import { compose, type FieldRef } from '@mmstack/forms';

const firstError = (f: FieldRef) => () => f.state().errors()[0]?.message ?? '';

readonly field = compose({
  label: withLabel,   // a fieldMetadata rule carries its projector
  required: REQUIRED, // a MetadataKey composes directly
  error: firstError,
  invalid: (f: FieldRef) => () => f.state().invalid(),
});
// template: {{ field.label() }} / {{ field.error() }}`;

  protected readonly lazy = `(f) => () => f.state().value(); // lazy, returns a getter
(f) => f.state().value;         // eager, runs before the field is bound`;

  protected readonly composition = `import { composition, fromMetadata } from '@mmstack/forms';

const [textField, injectTextField] = composition({ label: withLabel, error: firstError });

const [select, injectSelect] = composition({
  ...textField, // extend by spreading
  options: fromMetadata(OPTIONS, []),
});

// in a control:
readonly field = injectSelect(); // { label, error, options }, one inject`;

  protected readonly fromMetadata = `import { MIN, REQUIRED } from '@angular/forms/signals';
import { composition, fromMetadata } from '@mmstack/forms';

const [numberField, injectNumberField] = composition({
  required: fromMetadata(REQUIRED, false), // Signal<boolean>, never undefined
  min: MIN,                                // bare key, Signal<number | undefined>
});`;

  protected readonly fragments = `import { changeTracking, reconciliation, composition } from '@mmstack/forms';

const [textField, injectTextField] = composition({
  ...changeTracking(), // adds changed + reset
  label: withLabel,
});

const [entityField, injectEntityField] = composition({
  ...reconciliation(), // adds changed + reset + reconcile
  label: withLabel,
});

// in a control:
const f = injectEntityField();
f.changed();          // Signal<boolean>
f.reset();            // revert to baseline
f.reconcile(server);  // merge server data, keep in-flight edits`;

  protected readonly fieldRef = `import { injectFieldRef } from '@mmstack/forms';

// in a control's injection context:
const ref = injectFieldRef('myControl'); // FieldRef, throws if no [formField] host
ref.state();     // the live FieldState
ref.formField;   // the bound FormField directive instance`;
}
