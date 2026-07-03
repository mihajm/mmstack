import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-signals',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Signal variants"
      pkg="@mmstack/primitives"
      lead="Writable signals with an extra edge. mutable edits an object or array in place, derived gives you a two-way slice of another signal, and toWritable makes any read-only signal writable."
    >
      <docs-section title="mutable" id="mutable">
        <p>
          <code>mutable</code> is a <code>WritableSignal</code> with two extra
          methods, <code>mutate</code> and <code>inline</code>, for editing an
          object or array in place. It is cheaper than spreading a large value
          on every change (<code
            >update(prev =&gt; ({{ '{' }} ...prev {{ '}' }}))</code
          >) and it still notifies readers.
        </p>
        <docs-code [code]="mutableEx" lang="ts" />
        <p>
          <code>mutate</code> takes a function that returns the value;
          <code>inline</code> is the same but returns <code>void</code>, so you
          just edit and let it fall through. Both notify dependents after the
          callback runs.
        </p>
        <p>
          One caveat. A <code>computed()</code> that returns a non-primitive
          value derived from a mutable signal must declare
          <code>{{ '{' }} equal: false {{ '}' }}</code> (or
          <code>() =&gt; false</code>). The reference-equality default would
          otherwise suppress the change notification, because the object edited
          in place keeps the same reference, so stability is at the leaves of
          the graph. Same principle applies to inputs, binding a non-primitive
          mutable to an input wont trigger it, pass the whole signal through.
        </p>
        <docs-code [code]="mutableEqualEx" lang="ts" />
        <p>
          mutable is an extension of signal so <code>.set() / .update</code> &
          passed-in equality work in the same immutable manner as they would
          otherwise, it just adds the option + handling for mutation.
        </p></docs-section
      >

      <docs-section title="derived" id="derived">
        <p>
          <code>derived</code> gives you a two-way-bound slice of another
          <code>WritableSignal</code>. Writes to the slice update the source,
          and changes to the source flow through. Use a key or index shorthand
          for object and array slices.
        </p>
        <p>
          Sidenote, this is fundementally just a reactive variation of a
          write-through lens :)
        </p>
        <docs-code [code]="derivedKeyEx" lang="ts" />
        <p>
          For anything beyond a plain slice, pass a
          <code>{{ '{' }} from, onChange {{ '}' }}</code> pair.
          <code>from</code> reads the value out of the source, and
          <code>onChange</code> writes the next value back into it.
        </p>
        <docs-code [code]="derivedCustomEx" lang="ts" />
        <p>
          Mutability propagates. When the source is a
          <code>MutableSignal</code>, the derived slice is one too, so
          <code>derived(state, 'items').mutate(...)</code> writes back
          correctly.
        </p>
        <p>
          Writing through a <code>null</code> or <code>undefined</code> source
          drops the write by default. Pass <code>vivify</code> on the key or
          index form to create the missing container instead:
          <code>'object'</code>, <code>'array'</code>, <code>'auto'</code> (an
          array for index keys, an object otherwise), or a
          <code>() =&gt; container</code> factory.
        </p>
        <docs-code [code]="derivedVivifyEx" lang="ts" />
      </docs-section>

      <docs-section title="toWritable" id="to-writable">
        <p>
          <code>toWritable</code> turns any read-only
          <code>Signal&lt;T&gt;</code> into a
          <code>WritableSignal&lt;T&gt;</code> by supplying your own
          <code>set</code> (and optional <code>update</code>) implementation. It
          powers <code>derived</code> under the hood. Reach for it directly when
          you have a <code>computed</code> you want to expose as writable.
        </p>
        <docs-code [code]="toWritableEx" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class SignalVariantsDoc {
  protected readonly mutableEx = `import { mutable } from '@mmstack/primitives';

const user = mutable({ name: 'John', age: 30 });

user.mutate((prev) => {
  prev.age++;
  return prev;
});

user.inline((prev) => {
  prev.age++;
}); // void return, same effect useful for array.push / map.set shorthand`;

  protected readonly mutableEqualEx = `import { computed } from '@angular/core';
import { mutable } from '@mmstack/primitives';

const list = mutable([1, 2, 3]);

// returns a non-primitive derived from a mutable, so opt out of ref-equality
const doubled = computed(() => list().map((n) => n * 2), { equal: () => false });`;

  protected readonly derivedKeyEx = `import { signal } from '@angular/core';
import { derived } from '@mmstack/primitives';

const user = signal({ name: 'John', age: 30 });
const name = derived(user, 'name'); // WritableSignal<string>

const list = signal([1, 2, 3]);
const second = derived(list, 1); // WritableSignal<number>, the item at index 1

name.set('Ada'); // user() is now { name: 'Ada', age: 30 }`;

  protected readonly derivedCustomEx = `import { signal } from '@angular/core';
import { derived } from '@mmstack/primitives';

const user = signal({ name: 'John' });

const upper = derived(user, {
  from: (u) => u.name.toUpperCase(),
  onChange: (next) => user.update((u) => ({ ...u, name: next.toLowerCase() })),
});`;

  protected readonly derivedVivifyEx = `import { signal } from '@angular/core';
import { derived } from '@mmstack/primitives';

const user = signal<{ name: string } | null>(null);
derived(user, 'name', { vivify: 'object' }).set('Ada');
// user() is now { name: 'Ada' }`;

  protected readonly toWritableEx = `import { computed, signal } from '@angular/core';
import { toWritable } from '@mmstack/primitives';

const user = signal({ name: 'John' });

const name = toWritable(
  computed(() => user().name),
  (next) => user.update((u) => ({ ...u, name: next })),
);`;
}
