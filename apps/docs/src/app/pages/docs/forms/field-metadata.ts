import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-forms-field-metadata',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Field metadata"
      pkg="@mmstack/forms"
      lead="Attach typed values to a field, like a label or a set of options, and read them back in the control. fieldMetadata bundles Angular's metadata system into one tuple that reads like a native rule."
    >
      <docs-section title="Defining a key" id="define">
        <p>
          A control often needs data that is not part of the field's value: a
          label, a set of options, a hint. Signal Forms can carry it through
          their generic metadata system, but the read path is verbose and
          non-obvious. <code>fieldMetadata</code> bundles that system into one
          typed tuple that sets and reads like a native rule.
        </p>
        <p>
          <code>fieldMetadata&lt;T&gt;()</code> returns a
          <code>[rule, reader, key]</code> tuple, mirroring
          <code>injectable</code>. Name the rule and reader at the call site.
        </p>
        <docs-code [code]="define" lang="ts" />
      </docs-section>

      <docs-section title="Setting and reading" id="use">
        <p>
          Set the value in a schema next to <code>required</code> and
          <code>min</code>, then read it in a control the way you read an
          <code>input()</code>. The reader runs on a <code>[formField]</code>
          host and returns a signal.
        </p>
        <docs-code [code]="use" lang="ts" />
        <p>
          The value can be static or a reactive <code>LogicFn</code>. In the
          function form, the field's own value is typed, so a metadata value can
          depend on the field it sits on.
        </p>
        <docs-code [code]="logic" lang="ts" />
      </docs-section>

      <docs-section title="Resolution order" id="precedence">
        <p>
          At read time the value resolves in this order: the value set in the
          schema, then the component fallback you pass to the reader, then the
          base fallback on the key, then <code>undefined</code>. Only
          <code>undefined</code> counts as unset, so a schema-set
          <code>null</code> is a real value and does not fall through. The
          reader's type reflects this: <code>Signal&lt;T&gt;</code> when a
          fallback is guaranteed, <code>Signal&lt;T | undefined&gt;</code>
          otherwise.
        </p>
      </docs-section>

      <docs-section title="The key" id="key">
        <p>
          The third tuple element is the underlying
          <code>MetadataKey</code>, for stepping outside the sugar: set the
          attribute through the native <code>metadata()</code> rule, read it raw
          via <code>FieldState.metadata()</code>, or compose it directly.
        </p>
        <docs-code [code]="key" lang="ts" />
        <p>
          The key reads the raw accumulator,
          <code>Signal&lt;T | undefined&gt;</code>, with no fallbacks applied.
          Fallbacks are reader and projector sugar, so
          <code>injectLabel()</code> and
          <code>state().metadata(LABEL)?.()</code> can legitimately differ on a
          field that was never set.
        </p>
        <p>
          One caveat: the reader must run on or under a
          <code>[formField]</code> host, because it resolves through the
          <code>FORM_FIELD</code> token that the directive provides. To read
          field state from a wrapper directive, inject that token. Do not
          declare your own <code>formField</code> input, or you trip the
          directive's pass-through and break the native value binding.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class FieldMetadataDoc {
  protected readonly define = `import { fieldMetadata } from '@mmstack/forms';

export const [withLabel, injectLabel, LABEL] = fieldMetadata<string>({
  debugName: 'label',
});`;

  protected readonly use = `import { form, required } from '@angular/forms/signals';

const f = form(model, (p) => {
  required(p.name);
  withLabel(p.name, 'Full name'); // set in the schema
});

// in the control, on a [formField] host:
readonly label = injectLabel('(unlabeled)'); // Signal<string>`;

  protected readonly logic = `withLabel(p.count, ({ value }) => \`\${value().toFixed(0)} items\`);
// value() is number-typed here`;

  protected readonly key = `import { metadata } from '@angular/forms/signals';

form(model, (p) => metadata(p.name, LABEL, () => 'Full name')); // native rule
state().metadata(LABEL)?.(); // raw read`;
}
