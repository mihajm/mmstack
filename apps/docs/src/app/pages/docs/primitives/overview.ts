import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-overview',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Primitives"
      pkg="@mmstack/primitives"
      lead="A low-level toolbox for Angular signals: the small, composable helpers you reach for once you are building on signals for real, from deep reactive stores to concurrent UI that stops flashing spinners."
    >
      <docs-section title="Install" id="install">
        <docs-code [code]="install" lang="bash" />
        <p>
          Every value-producing helper here is a pure derivation. There is no
          <code>effect()</code> inside, no RxJS bridge, and no zone churn, so
          you can compose them in <code>computed()</code> graphs without
          thinking about side-effect lifetimes. The effect-shaped helpers
          (sensors, <code>tabSync</code>, <code>nestedEffect</code>) clean up
          through <code>DestroyRef</code>.
        </p>
      </docs-section>

      <docs-section title="What's in the box" id="pick">
        <p>
          The library splits into a handful of families. Skim the table for the
          one that matches what you are trying to do; each row links to its
          page.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>You want to</th>
              <th>Reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Write into a big object in place, or bind a slice of a signal two-way</td>
              <td>
                <a mmLink="/docs/primitives/signals">Signal variants</a>:
                <code>mutable</code>, <code>derived</code>, <code>toWritable</code>
              </td>
            </tr>
            <tr>
              <td>Turn a whole object into a tree of independently reactive signals</td>
              <td>
                <a mmLink="/docs/primitives/store">Store</a>:
                <code>store</code>, <code>mutableStore</code>,
                <code>forkStore</code>, <code>opLog</code>
              </td>
            </tr>
            <tr>
              <td>Map an array or record into stable, per-item derived values</td>
              <td>
                <a mmLink="/docs/primitives/collections">Mapped collections</a>:
                <code>indexArray</code>, <code>keyArray</code>, <code>mapObject</code>
              </td>
            </tr>
            <tr>
              <td>Debounce or throttle a signal, or wait for a condition</td>
              <td>
                <a mmLink="/docs/primitives/timing">Timing</a>:
                <code>debounced</code>, <code>throttled</code>, <code>until</code>
              </td>
            </tr>
            <tr>
              <td>Persist a signal, sync it across tabs, or add undo and redo</td>
              <td>
                <a mmLink="/docs/primitives/storage">Storage &amp; history</a>:
                <code>stored</code>, <code>tabSync</code>, <code>withHistory</code>
              </td>
            </tr>
            <tr>
              <td>Read browser state (media query, element size, network, pointer) as signals</td>
              <td><a mmLink="/docs/primitives/sensors">Sensors</a></td>
            </tr>
            <tr>
              <td>Compose signal transforms without reaching for RxJS or effects</td>
              <td>
                <a mmLink="/docs/primitives/pipelines">Pipelines</a>:
                <code>piped</code> + operators
              </td>
            </tr>
            <tr>
              <td>Time-slice heavy work or reuse allocations on a hot path</td>
              <td>
                <a mmLink="/docs/primitives/performance">Performance</a>:
                <code>chunked</code>, <code>pooled</code>
              </td>
            </tr>
            <tr>
              <td>Hold the UI through async work so it stops flashing spinners</td>
              <td>
                <a mmLink="/docs/primitives/transitions">Transitions &amp; suspense</a>:
                <code>*mmTransition</code>, <code>&lt;mm-suspense&gt;</code>,
                <code>latest</code>, <code>deferredValue</code>
              </td>
            </tr>
            <tr>
              <td>Keep a hidden tab mounted and pause its background work</td>
              <td>
                <a mmLink="/docs/primitives/pausing">Keep-alive &amp; pausing</a>:
                <code>*mmActivity</code>, <code>pausable*</code>
              </td>
            </tr>
          </tbody>
        </table>
      </docs-section>
    </docs-page>
  `,
})
export class PrimitivesOverview {
  protected readonly install = 'npm install @mmstack/primitives';
}
