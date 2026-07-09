import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-sync',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Sync and convergence"
      pkg="@mmstack/primitives"
      lead="The op-log turns a store into a stream of small structural operations. On top of it sit the pieces that keep two copies of a store in agreement: tab sync, a per-path merge policy, and a rebase routine. These are the same building blocks the worker and mesh packages use across a thread or a network boundary."
    >
      <p>
        A <a mmLink="/docs/primitives/store">store</a> updates copy-on-write, so
        every change keeps the references it did not touch. <code>opLog</code>
        diffs that into a minimal batch of <code>set</code> and
        <code>delete</code> operations, each along a path. Ship the batch and
        apply it elsewhere and you have replicated the change without sending the
        whole object. Everything on this page builds on that.
      </p>

      <docs-section title="Syncing a store across tabs" id="tab-sync">
        <p>
          <code>tabSync</code> has a store overload. Where the signal version
          mirrors a whole value, the store version ships operations, so two tabs
          editing different fields merge instead of clobbering each other. A tab
          that opens later hydrates from an existing one through a short
          handshake, then goes live.
        </p>
        <docs-code [code]="tabSync" lang="ts" />
        <p>
          Pass an explicit <code>id</code>. For a network boundary instead of
          tabs, the same engine is exposed as <code>opSync</code>, which emits
          and receives envelopes over any transport you give it. That is what
          <a mmLink="/docs/primitives/store">&#64;mmstack/mesh</a> wraps.
        </p>
      </docs-section>

      <docs-section title="Merge policies" id="policies">
        <p>
          When two peers change the same path at the same time, a merge policy
          decides the result. The default is last-writer-wins, ordered by a
          hybrid logical clock so every peer agrees. You attach a different
          policy per path pattern:
        </p>
        <ul>
          <li>
            <code>lww</code>: the latest write wins. The default, invisible.
          </li>
          <li>
            <code>mergeThree</code>: a three-way merge against the common
            ancestor, so concurrent edits to different fields of one object both
            land.
          </li>
          <li>
            <code>keyedArray(idFn)</code>: reconcile a list by item identity, so
            concurrent edits to different items survive and an edit beats a
            concurrent removal.
          </li>
          <li>
            <code>preserve</code>: keep both sides of a clash as a
            <code>Conflicted</code> value instead of dropping one. Resolution is
            just a later write.
          </li>
        </ul>
        <p>
          Last-writer-wins drops one side of a true clash on the same field. Set
          <code>preserve</code> on the paths where losing a write matters.
        </p>
        <docs-code [code]="policies" lang="ts" />
      </docs-section>

      <docs-section title="Conflicts as data" id="conflicted">
        <p>
          <code>preserve</code> exists for the cases where silently dropping a
          value is wrong, a clinical note edited by two people at once, say. The
          clashing leaf becomes a <code>Conflicted</code> holding every side that
          clashed in <code>siblings</code>, with <code>mine</code> and
          <code>theirs</code> naming the first two and <code>ancestor</code> the
          common base. Three or more people editing the same field at once all
          survive, not just two. Sync never blocks on it, and you resolve it when
          and how you choose. <code>isConflicted(value)</code> narrows the type.
        </p>
        <docs-code [code]="conflicted" lang="ts" />
      </docs-section>

      <docs-section title="Concurrent edits to a subtree" id="subtree">
        <p>
          When one peer replaces a whole object and another edits a field inside
          it at the same time, the field edit survives the replace. Replace
          <code>settings</code> while someone changes
          <code>settings.theme</code> and the result is the new settings with
          their theme kept, the merge people usually expect, rather than the
          replace erasing the concurrent edit. The edit was never observed by the
          replace, so it stays a live concurrent value.
        </p>
        <p>
          A privileged writer that needs the replace to win outright, an owner
          correcting a subtree, raises the write's authority so it clears the
          concurrent edits along with the old value. So an ordinary replace
          merges and an authoritative one overwrites, from the same mechanism.
        </p>
      </docs-section>

      <docs-section title="Ordered lists that merge" id="keyed-containers">
        <p>
          A keyed container is a record whose entries each carry their own
          position, so it reads back as an ordered list while staying a plain
          object under the hood. Because every element and its position are
          tracked on their own, two people reordering, editing, and inserting at
          once all keep their changes, and a single edit ships just that element
          rather than the whole list.
        </p>
        <ul>
          <li>
            <code>orderedEntries(container)</code>: the elements in reading
            order, each with its key, position, and value.
          </li>
          <li>
            <code>insertElement</code> / <code>moveElement</code> /
            <code>removeElement</code>: add at a position, reorder, or remove an
            element by key.
          </li>
          <li>
            <code>rebalanceContainer</code>: even out positions after many
            inserts into the same spot. Rarely needed; a dev warning tells you
            when.
          </li>
        </ul>
        <p>
          Reach for this over <code>keyedArray</code> when order matters or a
          list is edited by several people at once. <code>keyedArray</code>
          reconciles a whole array as one value; a keyed container tracks each
          element, so a move and an edit to the same list merge instead of
          racing.
        </p>
        <docs-code [code]="keyedContainer" lang="ts" />
      </docs-section>

      <docs-section title="Rebase and forks" id="rebase">
        <p>
          <code>rebaseOps</code> is the routine that reconciles local pending
          changes against a change that arrived first: invert the pending ops,
          apply the remote batch, then re-apply the pending on top through the
          merge policies. It is pure, and it is what an optimistic update or an
          offline queue needs.
        </p>
        <p>
          A <a mmLink="/docs/primitives/store">fork</a> is the same idea across
          time rather than space. <code>fork.ops()</code> exposes the staged
          delta as operations, and <code>policyStrategy(policies)</code> gives a
          fork the same per-path resolution, so a fork can hold a
          <code>Conflicted</code> value when the base moves underneath it instead
          of clobbering an edit.
        </p>
        <docs-code [code]="rebase" lang="ts" />
        <p>
          A fork is also how you review changes before they reach a synced room:
          the writer, an AI agent for instance, works on a fork, and a person
          approves the commit. <code>syncedFork</code> wires a fork to a sync so
          the commit cites what the fork observed when it forked: an edit that
          lands on the room mid-review stays a concurrent value the merge policy
          decides, never silently steamrolled by the approval. Call
          <code>rebase()</code> to re-observe the room before committing on top.
          See <a mmLink="/docs/mesh/agents">agents</a> for the full pattern.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class SyncDoc {
  protected readonly tabSync = `import { store, tabSync } from '@mmstack/primitives';

const prefs = tabSync(store({ theme: 'dark', sidebar: true }), { id: 'prefs' });

// another tab toggling the sidebar and this tab changing the theme both survive
prefs.theme.set('light');`;

  protected readonly policies = `import { keyedArray, mergeThree, preserve } from '@mmstack/primitives';

const policies = [
  { path: 'todos', merge: keyedArray((t) => t.id) },
  { path: 'settings', merge: mergeThree },
  { path: 'title', merge: preserve },
];`;

  protected readonly keyedContainer = `import { signal } from '@angular/core';
import { orderedEntries, insertElement, moveElement } from '@mmstack/primitives';

// a record of tasks, each carrying its own position
const tasks = signal<Record<string, Task>>({});

insertElement(tasks, 't1', { title: 'Draft' });          // append
insertElement(tasks, 't2', { title: 'Review' });
moveElement(tasks, 't2', 0);                             // to the front

for (const { key, value } of orderedEntries(tasks())) {  // reading order
  render(key, value);
}`;

  protected readonly conflicted = `import { isConflicted } from '@mmstack/primitives';

const title = store.title();
if (isConflicted(title)) {
  // title.mine, title.theirs, title.ancestor
  store.title.set(chosenValue); // resolve with a normal write
}`;

  protected readonly rebase = `import { rebaseOps, forkStore, policyStrategy, preserve } from '@mmstack/primitives';

// optimistic / offline: reconcile pending local ops against the server's change
const { root, pending } = rebaseOps(localRoot, pendingBatches, remoteBatch, policies);

// a fork that preserves a clash when the base moves under it
const fork = forkStore(base, {
  strategy: policyStrategy([{ path: 'title', merge: preserve }]),
});
fork.ops(); // the staged delta, as structural operations`;
}
