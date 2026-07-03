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
          <code>localStorage</code> (or any adapter with the same three methods).
          You read and write it like a normal <code>WritableSignal</code>; it
          persists every change under the given <code>key</code> and reloads that
          value on the next visit. It is SSR-safe and falls back to the initial
          value when nothing is stored.
        </p>
        <docs-code [code]="stored" lang="ts" />
        <p>
          The returned signal adds two members. <code>.clear()</code> removes the
          entry and restores the fallback, and <code>.key</code> is a reactive
          signal of the active key. The key can be dynamic: point it at a signal
          and the stored value follows wherever the key goes. Pass
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
          <code>.canClear</code>, and a <code>.history</code> stack.
        </p>
        <docs-code [code]="withHistory" lang="ts" />
        <p>
          <code>maxSize</code> bounds both the undo and redo stacks. When the
          bound is hit, <code>cleanupStrategy</code> decides how to trim:
          <code>'shift'</code> drops the oldest entry, <code>'halve'</code> drops
          the older half at once.
        </p>
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
}
