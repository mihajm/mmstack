import { Component } from '@angular/core';
import { StoreDemo } from '@mmstack/demos';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-store',
  imports: [DocPage, DocSection, CodeExample, DemoBox, StoreDemo],
  template: `
    <docs-page
      title="Store"
      pkg="@mmstack/primitives"
      lead="Proxy an object into a tree of writable signals, one per property. Extend a store as a scoped overlay, fork it for a throwaway draft, and read a diff of every change as an operation log."
    >
      <docs-section title="store and mutableStore" id="store">
        <p>
          <code>store</code> proxies an object (or a signal of an object) into a
          tree of <code>WritableSignal</code>s, one per property, created lazily
          and cached. A deeply nested field stays independently reactive, and
          writing through it flows back into the source. Arrays expose their
          indices as signals plus a reactive <code>.length</code> signal and
          <code>Symbol.iterator</code>.
        </p>
        <docs-code [code]="storeEx" lang="ts" />
        <p>
          <code>mutableStore</code> is the same, backed by a
          <code>MutableSignal</code>. Mutability propagates, so every child gets
          <code>mutate</code> and <code>inline</code> too.
        </p>
        <docs-code [code]="mutableStoreEx" lang="ts" />
        <p>
          <code>store</code> and <code>mutableStore</code> take a plain value
          and create the source for you. When you already own the signal, reach
          for <code>toStore</code>, the factory both are built on: it proxies an
          existing <code>Signal</code> (or <code>WritableSignal</code> /
          <code>MutableSignal</code>) and preserves its writability, so a store
          layered over a signal you own writes back through it.
        </p>
        <docs-code [code]="toStoreEx" lang="ts" />
        <p>
          A write through a <code>null</code> or <code>undefined</code> path is
          dropped by default. Pass <code>vivify</code> to create the missing
          intermediate containers instead: <code>'auto'</code> (an array for
          index keys, an object otherwise), <code>'object'</code>,
          <code>'array'</code>, or a <code>() =&gt; container</code> factory.
        </p>
        <docs-code [code]="vivifyEx" lang="ts" />
        <p>
          Unions are supported by default & throughout the graph. A node can
          flip between array, record, primitive, and <code>null</code>, and a
          child signal you grabbed before the flip stays correct after it. If
          you can promise a node never flips between a leaf and a sub-store,
          pass <code>{{ '{' }} noUnionLeaves: true {{ '}' }}</code> to resolve
          each node's leaf-ness once instead of keeping it reactive. Leave it
          off if a value can switch between a primitive and an object or array.
        </p>
        <p>
          The names <code>set</code>, <code>update</code>, <code>mutate</code>,
          <code>inline</code>, and <code>asReadonly</code> resolve to the
          signal's own methods, so record keys with those names are not
          reachable as child stores. Read them off the value
          (<code>s().set</code>) instead.
        </p>
        <docs-demo title="Edit nested state, no spread">
          @defer (on viewport) {
            <demo-store />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
      </docs-section>

      <docs-section title="opaque, an indivisible leaf" id="opaque">
        <p>
          By default the store proxies into every plain object it finds. When a
          value is a self-contained blob you never address by path (a parsed
          config, a third-party object, a class instance you keep whole) that is
          wasted machinery. <code>opaque(value)</code> marks it so the store
          treats it as a single leaf, the same way it already treats a
          <code>Date</code> or a <code>RegExp</code>: it comes back whole from a
          read, and you replace it with a <code>set</code> rather than reaching
          into its keys.
        </p>
        <docs-code [code]="opaqueEx" lang="ts" />
        <p>
          The marker is a non-enumerable symbol, so it never shows up in spreads
          or iteration, and the call is idempotent. Mark before you freeze,
          since the marker is written with <code>defineProperty</code>.
          <code>isOpaque(value)</code> is the matching guard, for niche interop.
        </p>
      </docs-section>

      <docs-section title="extendStore" id="extend-store">
        <p>
          <code>extendStore(store, seed)</code> creates a scoped overlay: a
          child store that shares the parent's signals for inherited keys (the
          same <code>WritableSignal</code>, so writes go through and parent
          changes flow down) while keeping the seed and any new keys in a local
          layer that never propagates upward.
        </p>
        <docs-code [code]="extendEx" lang="ts" />
        <p>
          Resolution per key is local, then parent, then local. A seed key (or
          one set on the scope before it exists on the parent) is local and
          shadows the parent, and keeps shadowing even if the parent later grows
          that key. A parent-only key writes through. A brand-new key lands
          locally. The scope inherits the parent's <code>vivify</code> and
          <code>noUnionLeaves</code> config, so <code>extendStore</code> does
          not take those options. It composes:
          <code>extendStore(extendStore(app, x), y)</code> chains parents.
        </p>
        <p>
          The seed can also be a signal of the matching kind, so an existing,
          externally owned signal becomes the local layer.
        </p>
      </docs-section>

      <docs-section title="forkStore" id="fork-store">
        <p>
          <code>forkStore(base)</code> creates an isolated, writable overlay on
          a base store. Writes stay local to the fork, so the base is untouched;
          paths the fork has not edited read through to the base.
          <code>commit()</code> flushes the fork's value onto the base, and
          <code>discard()</code> drops the staged writes. Use it for drafts,
          edit-and-cancel dialogs, and optimistic branches.
        </p>
        <docs-code [code]="forkEx" lang="ts" />
        <p>
          The fork is a full store: deep reads and writes,
          <code>extendStore</code>, everything <code>store</code> gives you, all
          under <code>draft.store</code>. It is built on
          <code>linkedSignal</code>, so it holds local writes until the base
          changes underneath it, then runs a <code>strategy</code> to reconcile.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>strategy</th>
              <th>Behavior</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>'fine'</code></td>
              <td>
                Per-path 3-way merge. Keep the paths the fork edited, take the
                base's live values for the rest. Default for an immutable base.
                Unsupported on a mutable base (it falls back to
                <code>'coarse'</code>).
              </td>
            </tr>
            <tr>
              <td><code>'coarse'</code></td>
              <td>
                Any base change resets the whole fork. Cheapest, and correct
                when the base is held for the fork's lifetime. Default for a
                mutable base.
              </td>
            </tr>
            <tr>
              <td><code>ReconcileFn&lt;T&gt;</code></td>
              <td>
                <code>(ancestor, mine, theirs) =&gt; merged</code>, for a
                bring-your-own merge (array-by-id, Immer patches, CRDT-ish).
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          The fork inherits the base's <code>vivify</code> and
          <code>noUnionLeaves</code> automatically. Pass them explicitly only to
          override.
        </p>
        <p>
          The 3-way merge behind <code>'fine'</code> is exported as
          <code>merge3(ancestor, mine, theirs)</code>, so a bring-your-own
          <code>ReconcileFn</code> can lean on it and only special-case the
          paths it cares about. It short-circuits untouched subtrees by
          reference identity (structural sharing keeps their references stable),
          so it deep-walks only the paths both sides changed. That same contract
          is why it needs the copy-on-write reference stability a store gives
          it.
        </p>
      </docs-section>

      <docs-section title="projection, a derived store" id="projection">
        <p>
          <code>projection</code> is the store-shaped counterpart to
          <code>computed</code>. Where a <code>computed</code> derives one
          value, <code>projection</code> derives a whole store subtree: the
          function receives a mutable draft seeded with the current value,
          mutates it in place or returns new data, and the result is reconciled
          against the previous value by identity. Unchanged object subtrees
          keep their reference, and array items matched by
          <code>key</code> keep their identity across a reorder, insert, or
          remove.
        </p>
        <docs-code [code]="projectionEx" lang="ts" />
        <p>
          That reconciliation is what makes reads through the result
          fine-grained. The whole projection recomputes on the first read after
          a signal it depends on changes, exactly like a
          <code>computed</code> (memoized, lazy, coherent right after a write),
          but a <code>computed</code> over one field only recomputes when that
          field actually changed, because everything else kept its reference.
          The function must be pure, it runs inside the reactive computation.
          Prefer <code>computed</code> for a plain value; reach for
          <code>projection</code> when a derivation should be read like a
          store.
        </p>
        <p>
          The reconciler is exported standalone as
          <code>reconcile(prev, next, key)</code>, for producing a
          reference-stable value by hand. Values must be structured-clonable,
          since the draft is a clone of the current value.
        </p>
      </docs-section>

      <docs-section title="opLog" id="op-log">
        <p>
          <code>opLog</code> is an operation log over any object-shaped
          <code>WritableSignal</code> that honors the copy-on-write contract.
          Stores qualify, and so do plainly immutably-updated model signals.
          Each tick's changes are recovered as one batch of path-level
          <code>set</code> and <code>delete</code> ops by a
          reference-identity-pruned diff, from outside the signal, at a cost of
          O(changed paths) and zero when no log exists.
        </p>
        <docs-code [code]="opLogEx" lang="ts" />
        <p>
          <code>subscribe</code> is ordered and lossless, the feed for sync and
          persistence. <code>latest</code> is a
          <code>Signal&lt;OpBatch | null&gt;</code>, a lossy sampling view for
          devtools. <code>apply</code> applies a batch in one commit and
          advances the diff baseline in the same step, so applying a remote
          batch emits no echo. Sync loops terminate by construction.
        </p>
        <docs-code [code]="opLogApplyEx" lang="ts" />
        <p>
          <code>invertBatch(batch)</code> returns a prev-based inverse, so undo
          is a data transform. Batching is per tick (two writes to one leaf in a
          tick compose into one op), and a <code>forkStore</code>'s
          <code>commit()</code> lands as a single batch. Mutable stores are
          unsupported here, since in-place mutation defeats the
          reference-identity diff.
        </p>
      </docs-section>
    </docs-page>
  `,
  styles: `
    .defer-hint {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin: 0;
    }
  `,
})
export class StoreDoc {
  protected readonly storeEx = `import { store } from '@mmstack/primitives';

const state = store({
  user: { name: 'Alice', address: { city: 'NYC', zip: 10001 } },
  tags: ['admin', 'editor'],
});

state.user.address.city();        // read: 'NYC' & trigger only on .city() changes
state.user.address.zip.set(90210); // two-way write into the source
state.tags[0]();                  // 'admin'
state.tags.length();              // 2, reactive`;

  protected readonly mutableStoreEx = `import { mutableStore } from '@mmstack/primitives';

const settings = mutableStore({ notifications: { email: true } });

settings.notifications.mutate((n) => {
  n.email = false;
});`;

  protected readonly toStoreEx = `import { signal } from '@angular/core';
import { toStore } from '@mmstack/primitives';

const source = signal({ user: { name: 'Alice' } });

const state = toStore(source); // proxies the signal you already own
state.user.name.set('Bob');    // writes back through source
source().user.name;            // 'Bob'`;

  protected readonly opaqueEx = `import { opaque, store } from '@mmstack/primitives';

const state = store({
  editorConfig: opaque({ theme: 'dark', plugins: { fold: true } }),
});

state.editorConfig();                             // the whole object, not a child store
state.editorConfig.set(opaque({ theme: 'light', plugins: {} }));`;

  protected readonly vivifyEx = `import { store } from '@mmstack/primitives';

const form = store(
  { user: null as { address?: { city: string } } | null },
  { vivify: 'auto' },
);

form.user.address.city.set('NYC');
// form() is now { user: { address: { city: 'NYC' } } }`;

  protected readonly extendEx = `import { extendStore, store } from '@mmstack/primitives';

const app = store({ user: { name: 'Alice' }, theme: 'dark' });

const scope = extendStore(app, { draft: '' }); // inherits user + theme, adds a local draft

scope.user === app.user;    // true, the same signal (shared, two-way)
scope.user.name.set('Bob'); // writes through to the parent
scope.draft.set('hello');   // local only, app never gains 'draft'
scope();                    // { user: { name: 'Bob' }, theme: 'dark', draft: 'hello' }`;

  protected readonly forkEx = `import { forkStore, store } from '@mmstack/primitives';

const base = store({ user: { name: 'Alice', age: 30 }, theme: 'dark' });

const draft = forkStore(base);
draft.store.user.name.set('Bob'); // local only, base still reads 'Alice'
base.user.name();                  // 'Alice'

draft.commit();     // flush the edits onto the base
base.user.name();   // 'Bob'
// draft.discard(); // or throw the edits away`;

  protected readonly projectionEx = `import { projection } from '@mmstack/primitives';

const users = signal<User[]>([...]);

// a read-only store derived from a computation, reconciled by 'id'
const active = projection<User[]>(
  () => users().filter((u) => u.active),
  [],
  { key: 'id' },
);

active[0].name(); // per-leaf reads, like any store

// the draft form: mutate in place instead of returning
const summary = projection<{ total: number; active: number }>(
  (draft) => {
    draft.total = users().length;
    draft.active = users().filter((u) => u.active).length;
  },
  { total: 0, active: 0 },
);`;

  protected readonly opLogEx = `import { opLog, store } from '@mmstack/primitives';

const state = store({ user: { name: 'Ann' }, items: [1, 2] });
const log = opLog(state);

log.subscribe((batch) => send(batch)); // lossless, ordered
log.latest();                          // Signal<OpBatch | null>, lossy sampling

state.user.name.set('Bea');
// batch: { origin, version, ops: [{ kind: 'set', path: ['user','name'], next: 'Bea', prev: 'Ann' }] }`;

  protected readonly opLogApplyEx = `import { invertBatch } from '@mmstack/primitives';

log.apply(remoteBatch);   // one commit, advances the baseline, emits no echo
invertBatch(batch);       // prev-based inverse, undo is a data transform`;
}
