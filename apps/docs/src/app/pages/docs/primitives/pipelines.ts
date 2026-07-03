import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-pipelines',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Pipelines"
      pkg="@mmstack/primitives"
      lead="A chainable .pipe(...) and .map(...) on any signal. Compose small operators into a derived signal, the way you would with an RxJS pipe, but staying in signals the whole way."
    >
      <docs-section title="Why pipelines" id="why">
        <p>
          Deriving one signal from another is just a <code>computed</code>. But
          once you want a few steps in sequence, project a shape, drop duplicate
          values, keep a running total, the <code>computed</code> body grows,
          and steps you would like to reuse get inlined and copied around.
        </p>
        <p>
          If you come from RxJS the instinct is to reach for a pipe of
          operators. Pipelines give you that shape without leaving signals: no
          subscription to manage, no <code>effect()</code> bridging a stream
          back into a signal. Each operator is a small
          <code>Signal</code> to <code>Signal</code> function, and
          <code>.pipe(...)</code> threads them together into one derived signal
          that stays synchronous and glitch-free.
        </p>
        <p>
          Reach for a pipeline when a derivation is more than a one-liner and
          you would rather read it as a sequence of named steps than as a dense
          <code>computed</code>.
        </p>
      </docs-section>

      <docs-section title="piped and pipeable" id="piped">
        <p>
          <code>piped(initial)</code> creates a writable signal that already
          carries the <code>.pipe(...)</code> and <code>.map(...)</code> API.
          <code>pipeable(existing)</code> adds the same API to a signal you
          already have. Both keep the underlying signal writable, so the source
          end stays a normal <code>WritableSignal</code>.
        </p>
        <docs-code [code]="piped" lang="ts" />
        <p>
          <code>.map(...)</code> is the quick path: pass one or more inline
          value-to-value functions and they run left to right.
          <code>.pipe(...)</code> is the same idea with the named operators
          below, where each one is a reusable
          <code>Signal</code>-to-<code>Signal</code> transform. The result of
          both is itself pipeable, so you can keep chaining.
        </p>
      </docs-section>

      <docs-section title="A real pipeline" id="example">
        <p>
          Say you have a stream of scroll deltas and want a distinct running
          total, tripled, without recomputing when the value has not actually
          changed. Read top to bottom: multiply, drop repeats, accumulate.
        </p>
        <docs-code [code]="operators" lang="ts" />
        <p>
          Every operator has the shape
          <code>(src: Signal&lt;I&gt;) =&gt; Signal&lt;O&gt;</code>, so the
          output type of one is the input type of the next and the chain stays
          fully typed.
        </p>
      </docs-section>

      <docs-section title="Operators by purpose" id="operators">
        <p>
          There are three groups. <strong>Projection</strong> reshapes a value:
          <code>map(fn)</code> is a pure transform, and
          <code>select(fn, opt?)</code> is the same with a
          <code>CreateSignalOptions</code> bag so you can pass a custom
          <code>equal</code> or <code>debugName</code> through to the underlying
          <code>computed</code>. <code>combineWith(other, fn)</code> projects the
          piped signal together with a second signal and recomputes when either
          changes.
        </p>
        <docs-code [code]="projectionEx" lang="ts" />
        <p>
          <strong>Gating</strong> controls which values pass.
          <code>distinct(equal?)</code> suppresses an emission when
          <code>equal(prev, next)</code> is true (defaults to
          <code>Object.is</code>), which is how you compare by
          <code>id</code> and ignore noisy fields. <code>filter(predicate)</code>
          keeps only passing values, holding the last one and returning
          <code>undefined</code> until the first match;
          <code>filterWith(predicate, initial)</code> is the same but seeds an
          initial value so the type never includes <code>undefined</code>.
        </p>
        <docs-code [code]="gatingEx" lang="ts" />
        <p>
          <strong>Stateful</strong> operators remember across emissions.
          <code>scan(reducer, seed)</code> folds each value into a running
          accumulator, like <code>Array.prototype.reduce</code> over time.
          <code>pairwise()</code> emits <code>[prev, curr]</code> tuples
          (<code>prev</code> is <code>undefined</code> on the first).
          <code>startWith(initial)</code> emits a seed first, then mirrors the
          source, handy for a loading value before real data arrives.
        </p>
        <p>
          One operator sits apart. <code>tap(fn, injector?)</code> runs a side
          effect through <code>effect()</code> and passes the value along
          unchanged, for logging or analytics. Because it uses
          <code>effect()</code> it needs an injection context, so pass an
          <code>Injector</code> when you build the pipeline outside one, and do
          not use it to write other signals.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Operator</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>map(fn)</code></td>
              <td>Pure value-to-value transform.</td>
            </tr>
            <tr>
              <td><code>select(fn, opt?)</code></td>
              <td>Projection with <code>CreateSignalOptions</code> passed through.</td>
            </tr>
            <tr>
              <td><code>combineWith(other, fn)</code></td>
              <td>Project two signals together; recomputes on either change.</td>
            </tr>
            <tr>
              <td><code>distinct(equal?)</code></td>
              <td>Suppress an emission when <code>equal(prev, next)</code> is true.</td>
            </tr>
            <tr>
              <td><code>filter(predicate)</code></td>
              <td>Keep passing values; <code>undefined</code> until the first match.</td>
            </tr>
            <tr>
              <td><code>filterWith(predicate, initial)</code></td>
              <td><code>filter</code> with a seed instead of <code>undefined</code>.</td>
            </tr>
            <tr>
              <td><code>scan(reducer, seed)</code></td>
              <td>Fold each value into a running accumulator.</td>
            </tr>
            <tr>
              <td><code>pairwise()</code></td>
              <td>Emit <code>[prev, curr]</code> tuples.</td>
            </tr>
            <tr>
              <td><code>startWith(initial)</code></td>
              <td>Emit a seed first, then mirror the source.</td>
            </tr>
            <tr>
              <td><code>tap(fn, injector?)</code></td>
              <td>Run a side effect via <code>effect()</code>; value passes through.</td>
            </tr>
          </tbody>
        </table>
      </docs-section>
    </docs-page>
  `,
})
export class PipelinesDoc {
  protected readonly piped = `import { piped, pipeable } from '@mmstack/primitives';

const count = piped(1);

// .map composes value -> value transforms inline
const label = count.map(
  (n) => n * 2,
  (n) => \`#\${n}\`,
);

// .pipe retrofits onto an existing signal too
const view = pipeable(signal(0)).pipe(/* operators */);`;

  protected readonly operators = `import { pipeable, map, distinct, scan } from '@mmstack/primitives';

const total = pipeable(signal(10)).pipe(
  map((n) => n * 3),
  distinct(),
  scan((acc, n) => acc + n, 0),
);`;

  protected readonly projectionEx = `import { pipeable, select, combineWith } from '@mmstack/primitives';

const user = pipeable(signal({ id: 1, name: 'Ada' }));

// compare by id so unrelated field changes don't re-emit
const name = user.pipe(select((u) => u.name, { equal: (a, b) => a === b }));

const qty = signal(3);
const total = pipeable(signal(10)).pipe(combineWith(qty, (price, q) => price * q));`;

  protected readonly gatingEx = `import { pipeable, filter, distinct } from '@mmstack/primitives';

const event = pipeable(signal<MouseEvent | null>(null));

// undefined until the first click, then holds the last click
const lastClick = event.pipe(filter((e): e is MouseEvent => e?.type === 'click'));

// re-emit only when id changes, ignore noisy fields
const stable = user.pipe(distinct((a, b) => a.id === b.id));`;
}
