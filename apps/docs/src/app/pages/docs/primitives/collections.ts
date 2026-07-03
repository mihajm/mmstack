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
