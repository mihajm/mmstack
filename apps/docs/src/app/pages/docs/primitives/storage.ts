import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-storage',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="History and persistence"
      pkg="@mmstack/primitives"
      lead="Three wrappers around a writable signal that give it a memory. stored persists to localStorage, tabSync mirrors across tabs, and withHistory adds undo and redo. Each returns a signal you read and write like any other."
    >
      <docs-section title="stored" id="stored">
        <p>
          <code>stored</code> keeps a signal in sync with
          <code>localStorage</code> (or any adapter with the same three
          methods). You read and write it like a normal
          <code>WritableSignal</code>; it persists every change under the given
          <code>key</code> and reloads that value on the next visit. It is
          SSR-safe and falls back to the initial value when nothing is stored.
        </p>
        <docs-code [code]="stored" lang="ts" />
        <p>
          The returned signal adds two members. <code>.clear()</code> removes
          the entry and restores the fallback, and <code>.key</code> is a
          reactive signal of the active key. The key can be dynamic: point it at
          a signal and the stored value follows wherever the key goes. Pass
          <code>syncTabs: true</code> to keep the value in step across tabs
          through the browser <code>storage</code> event. Other tabs on the same
          key pick up each change.
        </p>
      </docs-section>

      <docs-section title="tabSync" id="tab-sync">
        <p>
          <code>tabSync</code> mirrors a <code>WritableSignal</code> across
          browser tabs over <code>BroadcastChannel</code>. It is what
          <code>&#64;mmstack/resource</code> uses internally for cache
          invalidation.
        </p>
        <docs-code [code]="tabSync" lang="ts" />
        <p>
          Provide an explicit <code>id</code> in production. The auto-generated
          stack-frame id is fine for prototyping but is not stable across
          minified builds.
        </p>
      </docs-section>

      <docs-section title="withHistory" id="with-history">
        <p>
          <code>withHistory</code> wraps a <code>WritableSignal</code> (or an
          initial value) into one that tracks its own edits. You get
          <code>.undo()</code>, <code>.redo()</code>, and <code>.clear()</code>,
          plus reactive <code>.canUndo</code>, <code>.canRedo</code>,
          <code>.canClear</code>, and a <code>.history</code> stack. As this
          composes with any WritableSignal we most use it to wrap Signal Forms
          sources and similar.
        </p>
        <docs-code [code]="withHistory" lang="ts" />
        <p>
          <code>maxSize</code> bounds both the undo and redo stacks. When the
          bound is hit, <code>cleanupStrategy</code> decides how to trim:
          <code>'shift'</code> drops the oldest entry,
          <code>'halve'</code> drops the older half at once.
        </p>
      </docs-section>

      <docs-section title="storeHistory" id="store-history">
        <p>
          <code>withHistory</code> snapshots a value. <code>storeHistory</code>
          does undo and redo for a <a mmLink="/docs/primitives/store">store</a>
          over its op-log instead, so each entry costs only the diff, not a full
          copy of the state. <code>undo()</code> applies one inverse batch, and a
          new edit after an undo forks the timeline, the same as any editor.
        </p>
        <docs-code [code]="storeHistory" lang="ts" />
        <p>
          It composes with sync. Pass a sync client's local stream as
          <code>track</code>, and only your own writes are undoable while a
          remote peer's change never lands on your stack. Your undo still emits a
          normal operation, so it propagates to the others.
        </p>
      </docs-section>

      <docs-section title="persistedStore" id="persisted-store">
        <p>
          <code>stored</code> persists a single value to synchronous
          <code>localStorage</code>. <code>persistedStore</code> persists a whole
          <a mmLink="/docs/primitives/store">store</a> to an async backend
          (IndexedDB) and restores it on boot. It ships no IndexedDB code: you
          pass an <code>AsyncStore</code> adapter, which
          <code>idb-keyval</code> satisfies directly and a Dexie table satisfies
          with a few lines. Wire the backend once with
          <code>providePersistedStoreOptions</code> and override per call.
        </p>
        <docs-code [code]="persistedStore" lang="ts" />
        <p>
          Because the backend is async, hydration cannot precede the first read:
          the store is live immediately with its initial value, then adopts the
          persisted snapshot once the backend answers, unless a write happened
          first. <code>hydrated</code> is a signal you can gate first paint on;
          writes are coalesced and flushed on teardown and page hide. This is
          local durability, not sync. For replication across tabs, a worker, or
          peers, compose <code>tabSync</code> or
          <code>&#64;mmstack/mesh</code> over the same store.
        </p>
        <p>
          When the persisted shape changes between releases, pass a
          <code>version</code> and a <code>migrate</code> hook. A snapshot
          written by an older version is brought forward on boot before it is
          adopted, then re-persisted in the new shape, so old data heals itself.
          Boot is already async, so <code>migrate</code> can be async too: lazy
          import the migration ladder and pay for it only when there is old data
          to migrate. A snapshot from a newer version than the running build is
          left untouched.
        </p>
        <p>
          <code>persistedStore</code> is <code>persist</code> plus a fresh store:
          reach for <code>persist(store, opt)</code> directly to add durability to
          a <a mmLink="/docs/primitives/store">store</a> you already have, for
          instance one you also <code>meshSync</code>, or a worker-owned store's
          replica. Persistence is a reader over the op-log, so it composes with
          the other readers on the same store.
        </p>
        <docs-code [code]="persist" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class StorageDoc {
  protected readonly stored = `import { stored } from '@mmstack/primitives';

const theme = stored<'light' | 'dark' | 'system'>('system', {
  key: 'app-theme',
  syncTabs: true,
});

theme.set('dark');
theme.key();    // Signal<string> of the active key
theme.clear();  // remove the entry, restore the fallback`;

  protected readonly tabSync = `import { tabSync } from '@mmstack/primitives';

const cart = tabSync(signal<Item[]>([]), { id: 'shopping-cart' });
// writes in one tab surface in the others`;

  protected readonly withHistory = `import { withHistory } from '@mmstack/primitives';

const text = withHistory('Hello', { maxSize: 10, cleanupStrategy: 'halve' });

text.set('Hello world');
text.undo();      // back to 'Hello'
text.redo();      // forward to 'Hello world'
text.canUndo();   // Signal<boolean>`;

  protected readonly storeHistory = `import { store, storeHistory } from '@mmstack/primitives';

const doc = store({ title: 'Draft', body: '' });
const history = storeHistory(doc);

doc.title.set('Final');
history.undo();       // title back to 'Draft'
history.canRedo();    // Signal<boolean>

// collaborative: only your own writes are undoable
storeHistory(doc, { track: syncClient });`;

  protected readonly persistedStore = `import * as idbKeyval from 'idb-keyval';
import { persistedStore, providePersistedStoreOptions } from '@mmstack/primitives';

// wire the backend once
providePersistedStoreOptions({ store: idbKeyval });

// then anywhere
const draft = persistedStore({ title: '', body: '' }, { key: 'draft' });
draft.store.title.set('Hello');   // persisted, debounced
draft.hydrated();                 // Signal<boolean>, false until the snapshot loads
await draft.flush();              // force the write now
await draft.clear();              // remove the snapshot, reset to initial

// evolve the shape across releases, migrations lazy-loaded
const profile = persistedStore({ first: '', last: '' }, {
  key: 'profile',
  version: 2,
  migrate: async (data, from) => (await import('./migrations')).run(data, from),
});`;

  protected readonly persist = `import { store, persist } from '@mmstack/primitives';
import { meshSync } from '@mmstack/mesh';

// persist attaches to a store you already have; persistedStore is store() + persist()
const doc = store({ title: '', body: '' });
persist(doc, { key: 'draft', store: idbKeyval });   // durable to disk
meshSync(doc, { room: 'doc-42', writer, transport }); // and synced to peers
// two readers over one op-log: a persisted, synced store`;
}
