import { Component, signal } from '@angular/core';
import { Reorderable, ReorderableItem, injectReorderable } from '@mmstack/dnd';

type Row = { id: number; label: string };

const rows = (prefix: string): Row[] =>
  ['One', 'Two', 'Three', 'Four'].map((label, i) => ({
    id: i + 1,
    label: `${prefix} ${label}`,
  }));

/** Touch behaviour of pointer lists: axis-aware touch-action and long-press activation. */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-touch-dnd-example',
  imports: [Reorderable, ReorderableItem],
  template: `
    <main>
      <h1>Touch</h1>
      <p class="hint">
        The first list drags straight away (touch-action follows its axis). The
        second waits for a long press, so a swipe across it scrolls the page.
      </p>

      <h2>Vertical list, no handle</h2>
      <ul class="list" data-list="axis" [mmReorderable]="axisList">
        @for (row of axisList.items(); track row.id) {
          <li class="item" [mmReorderableItem]="row">{{ row.label }}</li>
        }
      </ul>

      <h2>Long press (300ms)</h2>
      <ul
        class="list"
        data-list="long-press"
        [attr.data-active]="longPress.activeKey() ?? ''"
        [mmReorderable]="longPress"
      >
        @for (row of longPress.items(); track row.id) {
          <li class="item" [mmReorderableItem]="row">{{ row.label }}</li>
        }
      </ul>

      <div class="spacer" aria-hidden="true"></div>
    </main>
  `,
  styles: `
    main {
      font-family: system-ui, sans-serif;
      max-width: 420px;
      margin: 0 auto;
      padding: 16px;
    }
    .hint {
      color: #555;
    }
    .list {
      list-style: none;
      padding: 0;
      margin: 0 0 24px;
    }
    .item {
      padding: 12px 16px;
      margin-bottom: 8px;
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 6px;
    }
    .spacer {
      height: 200vh;
    }
  `,
})
export class TouchDndExample {
  readonly axisRows = signal<Row[]>(rows('Axis'));
  readonly axisList = injectReorderable(this.axisRows, {
    key: (r) => r.id,
    engine: 'pointer',
    axis: 'y',
  });

  readonly longPressRows = signal<Row[]>(rows('Hold'));
  readonly longPress = injectReorderable(this.longPressRows, {
    key: (r) => r.id,
    engine: 'pointer',
    axis: 'y',
    touchActivation: { delay: 300 },
  });
}
