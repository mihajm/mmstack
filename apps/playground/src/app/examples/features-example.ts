import { Component, signal } from '@angular/core';
import { Draggable, DragHandle, DropTarget, fileDropTarget } from '@mmstack/dnd';

type Chip = { id: string; label: string; kind: 'allowed' | 'blocked' };

const isChip = (d: unknown): d is Chip =>
  !!d && typeof d === 'object' && 'kind' in (d as object);

/** A drop zone for OS files — wraps the `fileDropTarget` composable on its host. */
@Component({
  selector: 'mm-file-zone',
  template: `
    @if (names().length) {
      got: {{ names().join(', ') }}
    } @else {
      drop files here
    }
  `,
  host: { class: 'zone', '[class.over]': 'over()' },
})
export class FileDropZone {
  protected readonly names = signal<string[]>([]);
  private readonly ref = fileDropTarget({
    onDrop: ({ files }) => this.names.set(files.map((f) => f.name)),
  });
  protected readonly over = this.ref.isDragOver;
}

/**
 * Showcases core behaviours that benefit from real-browser coverage:
 * drag handles, conditional drop (`canDrop`), and external file drops.
 */
@Component({
  selector: 'mm-features-example',
  imports: [Draggable, DragHandle, DropTarget, FileDropZone],
  template: `
    <h2>Features</h2>

    <section>
      <h3>Drag handle</h3>
      <p class="hint">Only the grip starts a drag — the body doesn't.</p>
      <div class="box" mmDraggable [data]="item" [dragHandle]="grip">
        <span class="grip" mmDragHandle #grip="mmDragHandle">⋮⋮</span>
        <span class="body">card body</span>
      </div>
      <div
        class="zone"
        mmDropTarget
        #hz="mmDropTarget"
        [accepts]="isChip"
        [class.over]="hz.isDragOver()"
        (dropped)="handleDropped.set(true)"
      >
        @if (handleDropped()) { dropped ✓ } @else { handle target }
      </div>
    </section>

    <section>
      <h3>Conditional drop (canDrop)</h3>
      <p class="hint">The zone only accepts the “allowed” chip.</p>
      <div class="chip ok" mmDraggable [data]="allowed">allowed</div>
      <div class="chip no" mmDraggable [data]="blocked">blocked</div>
      <div
        class="zone"
        mmDropTarget
        #cz="mmDropTarget"
        [accepts]="isChip"
        [canDrop]="onlyAllowed"
        [class.over]="cz.isDragOver()"
        (dropped)="accepted.set($event.data.label)"
      >
        accepted: {{ accepted() || '—' }}
      </div>
    </section>

    <section>
      <h3>File drop (external adapter)</h3>
      <p class="hint">Drag a file from your OS onto the zone.</p>
      <mm-file-zone></mm-file-zone>
    </section>
  `,
  styles: `
    :host { display: block; padding: 1.5rem; font-family: system-ui, sans-serif; }
    h2 { margin: 0 0 1rem; }
    h3 { margin: 0 0 .25rem; color: #334155; }
    .hint { color: #64748b; margin: 0 0 .5rem; font-size: .85rem; }
    section { margin-bottom: 1.5rem; display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
    section h3, section .hint { flex-basis: 100%; margin-bottom: 0; }
    .box { display: inline-flex; align-items: center; gap: .5rem; background: white; border: 1px solid #e2e8f0; border-radius: 6px; padding: .5rem .75rem; }
    .grip { cursor: grab; color: #94a3b8; }
    .chip { padding: .4rem .8rem; border-radius: 999px; cursor: grab; border: 1px solid #e2e8f0; }
    .chip.ok { background: #dcfce7; }
    .chip.no { background: #fee2e2; }
    .zone { min-width: 160px; min-height: 56px; display: flex; align-items: center; justify-content: center;
      border: 1px dashed #cbd5e1; border-radius: 8px; color: #64748b; background: #f8fafc; padding: .5rem; }
    .zone.over { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
  `,
})
export class FeaturesExample {
  protected readonly isChip = isChip;
  protected readonly item: Chip = { id: 'h', label: 'handle', kind: 'allowed' };
  protected readonly allowed: Chip = { id: 'a', label: 'allowed', kind: 'allowed' };
  protected readonly blocked: Chip = { id: 'b', label: 'blocked', kind: 'blocked' };

  protected readonly handleDropped = signal(false);
  protected readonly accepted = signal<string | null>(null);

  protected readonly onlyAllowed = (args: { source: { data: Chip } }): boolean =>
    args.source.data.kind === 'allowed';
}
