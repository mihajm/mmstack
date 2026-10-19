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
          decides the result. With no policy the latest write wins, ordered by a
          hybrid logical clock so every peer agrees, except for arrays (see
          below). You attach a different policy per path pattern:
        </p>
        <ul>
          <li>
            <code>lww</code>: the latest write wins, whole. Set it on an array
            to keep that array out of the positional merge.
          </li>
          <li>
            <code>mergeThree</code>: a three-way merge against the value the
            other write replaced, so concurrent edits to different fields of one
            object both land.
          </li>
          <li>
            <code>keyedArray(idFn)</code>: the <code>keyedArray</code> merge
            policy reconciles a list by item identity, so concurrent edits to
            different items survive and an edit beats a concurrent removal.
            Items that share an identity correspond by value: one equal to an
            item in the base is that item, the rest pair in order, and two
            writers duplicating the same item give two copies, not three.
          </li>
          <li>
            <code>preserve</code>: keep both sides of a clash as a
            <code>Conflicted</code> value instead of dropping one. Resolution is
            just a later write.
          </li>
        </ul>
        <p>
          Last-writer-wins drops one side of a true clash on the same field. Set
          <code>preserve</code> on the paths where losing a write matters. The
          merges that look for an unchanged side (<code>mergeThree</code>, the
          positional default, the <code>keyedArray</code> merge policy) decide
          it by value: a side equal to what it replaced made no change, even as
          a fresh copy. <code>lww</code> and <code>preserve</code> do not look
          for one.
        </p>
        <docs-code [code]="policies" lang="ts" />
        <p>
          An array travels as one value, and with no policy two concurrent
          writes of it merge position by position: when both kept the length and
          neither moved a value, each slot takes the side that changed it, so
          base <code>[0, 0]</code> with <code>[1, 0]</code> and
          <code>[0, 2]</code> becomes <code>[1, 2]</code> everywhere. A length
          change or a moved value keeps the latest array whole. The merge does
          not know identities: a reorder that also edits every moved element
          reads as edits in place, so a concurrent edit lands on whatever now
          sits in its slot, and replacing an element while someone edits it
          merges the two field by field. For lists like that, use the
          <code>keyedArray</code> merge policy or a keyed container.
        </p>
        <p>
          This changed the fold, so 22.23 / 21.23 speak protocol 4 and refuse
          protocol 3 peers. An unversioned, protocol 3 or protocol 4 checkpoint
          loads and is re-derived from its registers (any other version throws);
          an offline outbox from before the upgrade is dropped, not replayed.
        </p>
      </docs-section>

      <docs-section title="Conflicts as data" id="conflicted">
        <p>
          <code>preserve</code> exists for the cases where silently dropping a
          value is wrong, a clinical note edited by two people at once, say. The
          clashing leaf becomes a <code>Conflicted</code> holding every side
          that clashed in <code>siblings</code>, with <code>mine</code> and
          <code>theirs</code> naming the first two and <code>ancestor</code> the
          value the second one replaced (not a common base). Three or more
          people editing the same field at once all survive, not just two. Sync
          never blocks on it, and you resolve it when and how you choose.
          <code>isConflicted(value)</code> narrows the type.
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
            element by key. A position is an index or a neighbour, see below.
          </li>
          <li>
            <code>rebalanceContainer</code>: even out positions after many
            inserts into the same spot. Rarely needed; a dev warning tells you
            when.
          </li>
        </ul>
        <p>
          Reach for this over the <code>keyedArray</code> merge policy when
          order matters or a list is edited by several people at once. The
          policy reconciles a whole array as one value after the fact; a keyed
          container is the identity-on-the-wire form, tracking each element, so
          a move and an edit to the same list merge instead of racing.
        </p>
        <docs-code [code]="keyedContainer" lang="ts" />
        <p>
          An insert or a move can name its place by a neighbour instead of an
          index. The <code>Anchor</code> type has three forms:
          <code>&#123; after: key &#125;</code>,
          <code>&#123; before: key &#125;</code>, and
          <code>&#123; empty: true &#125;</code> for a container with nothing
          else in it. <code>insertElement</code>, <code>moveElement</code>, and
          the <code>insert</code> and <code>move</code> of the
          <code>keyedContainer</code> and <code>wrappedContainer</code> helpers
          all accept one wherever they take an index.
        </p>
        <p>
          The anchor is resolved when the write is applied, against the order
          the container has then. A drop decided as "after
          <code>t7</code>" still lands right after <code>t7</code> when someone
          inserted elsewhere in the meantime, where an index would land in the
          slot it named, whatever sits there now. That makes an anchor the right
          thing to keep for a drop from another list or a palette, as much as
          for a local reorder. Resolving one is a single pass over the
          container, with no sort.
        </p>
        <p>
          If the anchor names no other element present, an absent key, the moved
          key itself, or <code>empty</code> while siblings remain, nothing is
          written and the call returns <code>undefined</code>. The
          <code>empty</code> misuse also logs in dev mode. Check the return
          value when the neighbour may have gone.
        </p>
        <p>
          An anchor is local intent, not a shared guarantee. Two peers that
          apply the same anchor against different states can place the element
          differently, exactly as they would with an index; the position writes
          that result still converge. And when two neighbours hold the same
          position, after concurrent inserts into one gap, there is no room
          between them, so a move after the first can land after both. An index
          has the same limit.
        </p>
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
          <code>Conflicted</code> value when the base moves underneath it
          instead of clobbering an edit. Both diff arrays as units, so array
          policies and the positional default apply to them as in the room.
        </p>
        <docs-code [code]="rebase" lang="ts" />
        <p>
          A fork is also how you review changes before they reach a synced room:
          the writer, an AI agent for instance, works on a fork, and a person
          approves the commit. <code>syncedFork</code> wires a fork to a sync so
          the commit cites what the fork observed when it forked: an edit that
          lands on the room mid-review stays a concurrent value the merge policy
          decides, never silently steamrolled by the approval. So the committed
          value can differ from the preview: a fork showing
          <code>[1, 0]</code> can commit to <code>[1, 2]</code> next to a peer's
          <code>[0, 2]</code>. Call <code>rebase()</code> to re-observe the room
          before committing on top. See
          <a mmLink="/docs/mesh/agents">agents</a> for the full pattern.
        </p>
      </docs-section>

      <docs-section title="Undo in a synced store" id="undo">
        <p>
          <code>storeHistory(store, &#123; track: sync, policies &#125;)</code>
          makes only your own writes undoable, and undo is selective: it takes
          back what your change did and keeps what others wrote since. In the
          array above, undoing your <code>[1, 0]</code> after the merge gives
          <code>[0, 2]</code>. Pass the same <code>policies</code> as the sync
          so each path undoes the way it merges. If others moved elements since
          your change, your previous array comes back whole and their move is
          lost, and an undo of your own reorder is identity-blind; keyed lists
          avoid both.
        </p>
        <p>
          With <code>coalesce</code>, a run of your changes is one entry: one
          write from the run's first value to its last, and its net is what
          differs between them. A peer's edit elsewhere never enters it; a
          peer's edit to a path you touch next ends the run.
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
moveElement(tasks, 't2', { after: 't1' });               // next to a neighbour, as the list stands now
insertElement(tasks, 't3', { title: 'Ship' }, { before: 't2' }); // same for an insert

const pos = moveElement(tasks, 't3', { after: 'gone' }); // no such neighbour
pos === undefined;                                       // nothing was written

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
