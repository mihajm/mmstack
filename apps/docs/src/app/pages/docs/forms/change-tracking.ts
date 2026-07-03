import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-forms-change-tracking',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Change tracking"
      pkg="@mmstack/forms"
      lead="Native dirty tells you a field was interacted with. changed tells you its value differs from a baseline, which is what you want for diffs, unsaved-changes guards, and server reconciliation."
    >
      <docs-section title="Tracking a form" id="track">
        <p>
          Add <code>trackChanges(model)</code> to a form. It adopts the model's
          initial value as the baseline, captured on the first effect flush
          after construction, so any edits made before then fold into the
          baseline and <code>changed</code> is meaningful with no extra wiring.
          Read it per field with <code>injectChanged</code>.
        </p>
        <docs-code [code]="track" lang="ts" />
        <p>
          Leaves compare against their own baseline and containers aggregate,
          with an <code>Object.is</code> short-circuit so a change only walks its
          own branch of the tree.
        </p>
      </docs-section>

      <docs-section title="Async initial data" id="async">
        <p>
          When the initial data arrives asynchronously, pass
          <code>{{ '{' }} manualCommit: true {{ '}' }}</code>. That skips the
          automatic baseline and every field reads as changed until you call
          <code>commitChanges</code> once the data lands. Call
          <code>commitChanges(f)</code> at any time to re-baseline to the current
          values, for example in the success path of a save.
        </p>
        <docs-code [code]="commit" lang="ts" />
      </docs-section>

      <docs-section title="Custom equality" id="equality">
        <p>
          Equality is <code>Object.is</code> at leaves by default. Override it
          per path with <code>changedEqual</code>, or replace the comparison
          entirely with <code>changedWith</code>.
        </p>
        <docs-code [code]="equality" lang="ts" />
        <p>
          Arrays diff their items by value, index by index, so a reorder of
          identity-tracked items still registers. One consequence: an override
          placed on an item path changes that item's own <code>changed</code>
          signal, not the array's. To change how the container itself diffs, put
          the override on the array path.
        </p>
      </docs-section>

      <docs-section title="Reading the diff and resetting" id="diff">
        <p>
          <code>changedValues(f)</code> returns a deep-partial of just the
          changed fields, ready to send to a server, or
          <code>undefined</code> when nothing differs. That read is an untracked
          snapshot for submit time. When you want the same information live, for
          a badge or a preview, <code>changedCount(f)</code> is a signal of how
          many units differ, and <code>changedPaths(f)</code> is a signal of the
          dot-joined paths that make up the diff, one per extraction unit. All
          three follow the same granularity: objects narrow per property, while
          arrays and leaves come through whole.
        </p>
        <p>
          <code>resetChanged</code> reverts to the baseline, and
          <code>resetInitial</code> sets a new value and baseline together.
        </p>
        <docs-code [code]="diff" lang="ts" />
        <p>
          Reach for <code>changedCount</code> when you need a plain "3 unsaved
          changes" count. It reads the same tracking machinery as
          <code>injectChanged()</code>, so a guard that asks "does this form have
          unsaved edits" can gate on <code>changedCount(f)() &gt; 0</code>
          without touching any internal metadata key.
        </p>
      </docs-section>

      <docs-section title="Server reconciliation" id="reconcile">
        <p>
          When a save returns the stored entity, or another client's edit
          arrives, <code>reconcile(f, incoming)</code> merges that data back into
          the form without clobbering edits still in flight. Unchanged fields
          adopt the incoming value, changed fields keep their edit, and every
          field's baseline becomes the incoming value, so a kept edit reads as
          changed against the new server state.
        </p>
        <p>
          The default merge walks objects per property and treats arrays and
          leaves as whole units. Override a single path with
          <code>reconcileWith</code> when a field needs its own merge, for
          example a smart array merge or a leaf that should always defer to the
          server. Your function receives the <code>current</code> and
          <code>incoming</code> values plus whether that field
          <code>changed</code>, and returns the value to keep.
        </p>
        <docs-code [code]="reconcileEx" lang="ts" />
        <p>
          Both change tracking and reconciliation are also available as
          composition fragments (<code>changeTracking</code>,
          <code>reconciliation</code>) when you build field types.
        </p>
      </docs-section>

      <docs-section title="Submitting the diff" id="submit">
        <p>
          <code>submitChanges(f, target)</code> is the whole save recipe as one
          call. It runs Angular's <code>submit()</code> first, so validators run,
          fields touch, and an invalid form blocks with no request. Then it sends
          the diff through the target and re-baselines what was sent on success,
          leaving dirty state alone on failure so a retry keeps the edits.
        </p>
        <p>
          The target is any object with a <code>mutateAsync</code> method, typed
          as <code>SubmitTarget</code>. An
          <a mmLink="/docs/resource">&#64;mmstack/resource</a>
          <code>mutationResource</code> fits that shape, and brings its own
          queue and supersede semantics along. By default the payload is the
          changed subset from <code>changedValues</code>, and a form with nothing
          changed resolves <code>true</code> without a request. The returned
          function is a <code>() =&gt; Promise&lt;boolean&gt;</code>:
          <code>true</code> when the form was valid and the save landed,
          <code>false</code> when validation blocked it or the error mapper
          attached field errors.
        </p>
        <docs-code [code]="submitEx" lang="ts" />
        <p>
          <code>SubmitChangesOptions</code> tunes the rest. Set
          <code>payload: 'full'</code> to always send the whole value instead of
          the diff. On success the submitted units re-baseline to the values that
          were actually sent, so an edit that landed mid-request stays dirty
          rather than being absorbed silently. That re-baseline is the
          <code>'commit'</code> default. Choose <code>onSuccess: 'reconcile'</code>
          to additionally merge the mutation's result back into the form, offered
          only when the result is assignable to the form model. An
          <code>errors</code> mapper turns a failure into Angular's server-error
          channel instead of rethrowing, and <code>ignoreValidators</code> is
          forwarded to <code>submit()</code>.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class ChangeTrackingDoc {
  protected readonly track = `import { form } from '@angular/forms/signals';
import { trackChanges, injectChanged } from '@mmstack/forms';

readonly model = signal<User>(emptyUser());
readonly f = form(this.model, trackChanges(this.model)); // baseline = initial value

// in any control:
readonly changed = injectChanged(); // Signal<boolean>`;

  protected readonly commit = `import { commitChanges, trackChanges } from '@mmstack/forms';

readonly f = form(this.model, trackChanges(this.model, { manualCommit: true }));

// once the async data has loaded into the model:
commitChanges(this.f); // establish the baseline now`;

  protected readonly equality = `import { changedEqual, changedWith, trackChanges } from '@mmstack/forms';

form(model, (p) => {
  changedEqual(p.profile.avatar, (a, b) => normalize(a) === normalize(b));
  changedWith(p.tags, (initial, current) => current.length !== initial.length);
  trackChanges(model)(p);
});`;

  protected readonly diff = `import { changedValues, changedCount, changedPaths } from '@mmstack/forms';

const patch = changedValues(this.f); // DeepPartial<User> | undefined, untracked snapshot
const count = changedCount(this.f);  // Signal<number>
const paths = changedPaths(this.f);  // Signal<readonly string[]>, e.g. ['name', 'address.city']`;

  protected readonly reconcileEx = `import { reconcile, reconcileWith, trackChanges } from '@mmstack/forms';

const f = form(model, (p) => {
  // a leaf that should always take the server value, even if edited locally:
  reconcileWith(p.updatedAt, ({ incoming }) => incoming);
  trackChanges(model)(p);
});

// on a save response or a pushed update:
reconcile(f, serverUser); // keeps in-flight edits, adopts the rest`;

  protected readonly submitEx = `import { submitChanges, trackChanges } from '@mmstack/forms';

readonly f = form(this.model, trackChanges(this.model));
readonly updateUser = mutationResource(/* ... */); // any { mutateAsync }

// sends the diff, re-baselines what was sent, merges the server echo back in:
readonly save = submitChanges(this.f, this.updateUser, { onSuccess: 'reconcile' });
// template: <button (click)="save()" [disabled]="f().submitting()">Save</button>`;
}
