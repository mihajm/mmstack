import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-timing',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Timing and propagation"
      pkg="@mmstack/primitives"
      lead="Shape when a signal's read value updates without changing how you write to it. debounced waits out a burst, throttled rate-limits it, and until turns a signal condition into a promise."
    >
      <docs-section title="debounced and debounce" id="debounce">
        <p>
          A debounced signal holds its read value until
          <code>ms</code> milliseconds after the last write. You still call
          <code>set</code> and <code>update</code> normally. Dependents just see
          the value settle instead of updating on every keystroke.
        </p>
        <p>
          There are two entry points.
          <code>debounced(initial, {{ '{' }} ms {{ '}' }})</code> creates a new
          writable already debounced.
          <code>debounce(sourceSignal, {{ '{' }} ms {{ '}' }})</code> wraps an
          existing signal. Both give you an <code>.original</code> signal for
          the immediate, un-debounced value.
        </p>
        <docs-code [code]="debounce" lang="ts" />
        <p>
          Read <code>query()</code> where you want the delayed value (a search
          request) and <code>query.original()</code> where you want the live one
          (an echo in the input).
        </p>
      </docs-section>

      <docs-section title="throttled and throttle" id="throttle">
        <p>
          Throttling caps propagation to at most one value per <code>ms</code>
          window. Same two-function shape as debounce:
          <code>throttled(initial, {{ '{' }} ms {{ '}' }})</code> creates one,
          <code>throttle(sourceSignal, {{ '{' }} ms {{ '}' }})</code> wraps one,
          and <code>.original</code> is the escape hatch to the immediate value.
        </p>
        <docs-code [code]="throttle" lang="ts" />
        <p>
          The default is trailing-edge only, so the latest write in a window
          lands when the window closes. Pass <code>leading: true</code> to emit
          the first write immediately, and <code>trailing: false</code> to
          suppress the closing fire. There is also a <code>flush()</code> on the
          throttled signal that emits the current value now and clears the open
          window, for a terminal update that should not wait out the cooldown.
        </p>
      </docs-section>

      <docs-section title="until" id="until">
        <p>
          <code>until</code> resolves a promise once a signal value satisfies a
          predicate. It handles type-narrowing predicates, an optional
          <code>timeout</code>, and auto-cancellation when the calling context
          is destroyed.
        </p>
        <docs-code [code]="until" lang="ts" />
        <p>
          A narrowing predicate carries its type through, so the resolved value
          is already the narrowed type with no extra cast. It resolves
          immediately if the current value already passes, and it needs an
          injection context (or an explicit <code>injector</code> option) to run
          its watcher.
        </p>
        <p>
          This primitive is useful for async interop, but primary I find myself
          reaching for it in testing, so that i can await/assert the exact
          signal change moment instead of working with fixture.whenStable &
          similar.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class TimingDoc {
  protected readonly debounce = `import { debounce, debounced } from '@mmstack/primitives';

// create a new writable, already debounced
const query = debounced('', { ms: 300 });

// or wrap an existing signal
const wrapped = debounce(signal(''), { ms: 300 });

effect(() => search(query()));            // fires 300ms after typing stops
effect(() => echo(query.original()));     // fires immediately`;

  protected readonly throttle = `import { throttle, throttled } from '@mmstack/primitives';

// trailing edge only (default): latest write lands when the window closes
const scroll = throttled(0, { ms: 200 });

// wrap an existing signal instead of creating one
const wrapped = throttle(signal(0), { ms: 200 });

// leading + trailing, lodash-style
const both = throttled(0, { ms: 200, leading: true, trailing: true });`;

  protected readonly until = `import { until } from '@mmstack/primitives';

const event = signal<Event | null>(null);

// narrowing predicate: click is typed MouseEvent
const click = await until(event, (e): e is MouseEvent => e instanceof MouseEvent);

// with a timeout
await until(progress, (p) => p === 100, { timeout: 5_000 });`;
}
