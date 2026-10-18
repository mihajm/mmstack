import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-collections',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Mapped collections"
      pkg="@mmstack/primitives"
      lead="Turn an array or record signal into a stable set of per-item derivations, so each item stays independently reactive across changes to the list."
    >
      <docs-section title="The problem they solve" id="why">
        <p>
          You have a signal holding an array, and you want a derived value per
          item: a formatted label, a small view model, a per-row control. The
          obvious move is a <code>computed</code> that maps over the array.
        </p>
        <p>
          That works, but it throws everything away and rebuilds it on every
          change. Change one item's name and the whole mapped array is recreated,
          which means fresh object references for every row. Anything downstream
          keyed on those references, a heavy component in a
          <code>&#64;for</code>, a chart, a drag handle, sees every row as new
          and re-renders the lot. There is also no stable per-item signal to hand
          to a child, since each pass produces new objects.
        </p>
        <p>
          These three helpers fix that. Each one maps a source array or record
          into a set of derived values that are <strong>created once per item
          and reused</strong> as the source changes. Change one item and only
          that item's derivation updates; the rest keep their identity. That
          gives you a stable per-item signal to pass down, and it lets change
          detection skip the rows that did not move.
        </p>
        <ul>
          <li>
            <code>indexArray</code> stabilizes an array <strong>by position</strong>.
          </li>
          <li>
            <code>keyArray</code> stabilizes an array <strong>by identity</strong>.
          </li>
          <li>
            <code>mapObject</code> is the record equivalent, stable
            <strong>by key</strong>.
          </li>
        </ul>
        <p>
          They also pool their internal buffers, so reordering a large list is
          much cheaper than mapping a <code>computed</code>.
        </p>
      </docs-section>

      <docs-section title="indexArray, the default" id="index-array">
        <p>
          <code>indexArray</code> is the one to reach for first. It maps the
          source into a stable array where each position gets its own writable
          child signal holding the item at that index. The mapping runs once per
          position and is reused as the array changes, so a growing list only
          creates entries for the new tail.
        </p>
        <docs-code [code]="indexEx" lang="ts" />
        <p>
          Because it is keyed by position, a mapped output follows the position,
          not the item. If the array reorders, position 0 keeps its derivation
          and its child signal simply reports the new item there. That is
          exactly what you want for a plain list of labels, and it is the
          cheaper of the two array helpers.
        </p>
        <p>
          If you know it from SolidJS, <code>mapArray</code> is a deprecated
          alias for <code>indexArray</code>; it stays for compatibility, so reach
          for <code>indexArray</code> in new code.
        </p>
      </docs-section>

      <docs-section title="keyArray, stable by identity" id="key-array">
        <p>
          <code>keyArray</code> stabilizes by identity instead. You pass a
          <code>key</code> selector; moving an item then carries its derivation
          along, and only the item's index signal updates. Here the mapping
          receives the item value and a <code>Signal&lt;number&gt;</code> for its
          current index.
        </p>
        <docs-code [code]="keyEx" lang="ts" />
        <p>
          The difference matters when an item owns something expensive that
          should survive a reorder: a rendered chart, a media element with
          playback state, a drag-and-drop row. With <code>indexArray</code> a
          reorder would hand each position a different item and force those to
          rebuild; with <code>keyArray</code> the instance moves with its item.
          If nothing downstream depends on instance reuse across reorders,
          <code>indexArray</code> is enough. Both accept an
          <code>onDestroy</code> callback that runs when a mapped entry is
          removed, so per-item resources can clean up.
        </p>
      </docs-section>

      <docs-section title="Duplicate keys" id="duplicate-keys">
        <p>
          Keys do not have to be unique. Every occurrence of a key gets its own
          entry, and an entry follows the occurrence it was built for, not its
          position among the duplicates. Which occurrence is which is decided by
          a few plain rules:
        </p>
        <ul>
          <li>
            <strong>The same reference keeps its entry.</strong> An item that is
            the same object before and after is that occurrence. With two
            objects of one key, <code>[a1, a2]</code> becoming
            <code>[a2]</code> destroys the entry built from <code>a1</code> and
            re-creates nothing.
          </li>
          <li>
            <strong
              >The same object listed several times only changes its
              count.</strong
            >
            Its occurrences cannot be told apart, so entries are created or
            destroyed for the difference and never swapped.
          </li>
          <li>
            <strong
              >Fresh objects are matched in order while their count stays the
              same.</strong
            >
            That is the immutable-update convention: replace every item with a
            new copy and each entry keeps its place.
          </li>
          <li>
            <strong
              >When the count of fresh objects changes, they are
              re-created.</strong
            >
            Nothing shows which one survived, so every entry they could belong
            to is destroyed and built again rather than guessed.
          </li>
        </ul>
        <p>
          If your duplicates come from immutable updates that also add or remove
          copies, keep the references you did not change, and the first rule
          keeps their entries. For lists whose keys never repeat none of this
          comes into play: each key is one entry, matched by key alone.
        </p>
      </docs-section>

      <docs-section title="Handles" id="handles">
        <p>
          The mapping function receives the entry's key as a third argument.
          Pass <code>handles: true</code> and it receives the entry's lifetime
          handle there instead: the raw key while that key never had duplicates,
          an opaque <code>&#123; key, n &#125;</code> object once it did. The
          handle stays the same for the life of the entry, even after the key
          becomes unique again, so it is a safe name for the entry.
          <code>isKeyHandle(value)</code> tells the two apart, and
          <code>handle.key</code> is the raw key.
        </p>
        <docs-code [code]="handlesEx" lang="ts" />
        <p>
          A handle is identified by its reference. One that crosses a
          structured-clone boundary, <code>postMessage</code>, a worker, or
          JSON, comes back as a plain object that <code>isKeyHandle</code>
          rejects and that matches no entry. Send the raw key across a boundary,
          never the handle.
        </p>
        <p>
          To find out that a list has duplicates at all, pass
          <code>onDuplicates</code>. It is called once per recompute that sees
          any, with the repeated keys as their actual values in first-occurrence
          order. Nothing is coerced to a string, so <code>1</code> and
          <code>"1"</code> are different keys. It runs untracked, so it cannot
          add reactive dependencies.
        </p>
        <docs-code [code]="onDuplicatesEx" lang="ts" />
      </docs-section>

      <docs-section title="Relative order" id="reorders">
        <p>
          Pass <code>order: true</code> and the result gains
          <code>reorders</code>, a read-only signal that says whether the
          entries changed their order relative to each other. It holds the
          permutation among the entries present both at its last evaluation and
          now, named by handle: <code>before</code> lists them in the old order,
          <code>after</code> the same handles in the new order. When they kept
          their relative order it is <code>null</code>.
        </p>
        <docs-code [code]="orderEx" lang="ts" />
        <p>
          Inserts and removals alone are not reorders. A prepend bumps every
          index signal and still leaves <code>reorders()</code> at
          <code>null</code>, so an animation or a sync layer can tell a real
          move from items shifting around an insert.
        </p>
        <p>
          The baseline is the signal's own last evaluation, shared by everyone
          who reads it. Changes it did not see fold into one transition, so
          swapping two items and swapping them back before it is read gives
          <code>null</code>. Reading the mapped array in between loses nothing,
          since that read does not move the baseline. The first read is
          <code>null</code>. Without the option nothing extra is created or
          computed.
        </p>
      </docs-section>

      <docs-section title="handles on its own" id="handles-fn">
        <p>
          The matching behind <code>keyArray</code> is exported as
          <code>handles(prev, items, keyOf)</code>, for code that tracks the
          identity of list occurrences without mapping them. Pass the previous
          table (or <code>null</code> the first time), the new items and a key
          function. You get back the new <code>table</code>, whose
          <code>handles</code> line up with the items, and the handles that
          retired, in <code>destroyed</code>.
        </p>
        <docs-code [code]="handlesFnEx" lang="ts" />
        <p>
          Like <code>pooled</code>, the table and <code>destroyed</code> are
          reused by the next call, so the previous state stays readable for
          exactly one call; copy anything you keep longer. An unchanged input
          returns the previous table as it is.
        </p>
      </docs-section>

      <docs-section title="mapObject for records" id="map-object">
        <p>
          <code>mapObject</code> is the record counterpart of
          <code>keyArray</code>. It maps a <code>Record&lt;K, V&gt;</code> into a
          <code>Record&lt;K, U&gt;</code> with referential stability for
          unchanged keys, and when the source is writable it hands the mapping a
          writable signal slice for each value, so each entry can both read and
          write its own value.
        </p>
        <docs-code [code]="mapObjectEx" lang="ts" />
        <p>
          The result is a set of self-contained controls, one per key, that stay
          the same objects until their key leaves the record. As with the array
          helpers, <code>onDestroy</code> runs when a key is removed.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class CollectionsDoc {
  protected readonly indexEx = `import { computed } from '@angular/core';
import { indexArray, mutable } from '@mmstack/primitives';

const items = mutable([
  { id: 1, name: 'A' },
  { id: 2, name: 'B' },
]);

// child is a MutableSignal<{ id, name }> for the current index
const labels = indexArray(items, (child, index) =>
  computed(() => \`Item \${index}: \${child().name}\`),
);`;

  protected readonly keyEx = `import { computed } from '@angular/core';
import { keyArray, mutable } from '@mmstack/primitives';

const items = mutable([
  { id: 1, name: 'A' },
  { id: 2, name: 'B' },
]);

// child is the item value, index is a Signal<number>
const keyed = keyArray(
  items,
  (child, index) => computed(() => \`\${index()}: \${child.name}\`),
  { key: (item) => item.id },
);`;

  protected readonly handlesEx = `import { isKeyHandle, keyArray } from '@mmstack/primitives';

const rows = keyArray(
  items,
  (item, index, handle) => ({
    handle, // the raw id, or an opaque handle once the id was duplicated
    id: isKeyHandle(handle) ? handle.key : handle,
    item,
  }),
  { key: (item) => item.id, handles: true },
);`;

  protected readonly onDuplicatesEx = `const rows = keyArray(items, render, {
  key: (item) => item.id,
  onDuplicates: (ids) => console.warn('repeated ids', ids), // e.g. [3, 7]
});`;

  protected readonly orderEx = `const rows = keyArray(items, render, {
  key: (item) => item.id,
  order: true,
});

rows.reorders(); // { before: [1, 2], after: [2, 1] } after a swap
// null after a prepend, an append or a removal`;

  protected readonly handlesFnEx = `import { handles, type HandleTable } from '@mmstack/primitives';

let table: HandleTable<Item, number> | null = null;

function observe(items: Item[]) {
  const next = handles(table, items, (item) => item.id);
  for (const gone of next.destroyed) release(gone);
  table = next.table; // table.handles[i] names items[i]
}`;

  protected readonly mapObjectEx = `import { signal } from '@angular/core';
import { mapObject } from '@mmstack/primitives';

const settings = signal<Record<string, boolean>>({
  wifi: true,
  bluetooth: false,
});

const controls = mapObject(
  settings,
  (key, value) => ({
    label: key.toUpperCase(),
    isActive: value, // WritableSignal<boolean>
    toggle: () => value.update((v) => !v),
  }),
  { onDestroy: (entry) => console.log(\`Removed \${entry.label}\`) },
);`;
}
