import { Component, computed, signal } from '@angular/core';
import {
  Canvas,
  CanvasItem,
  injectCanvas,
  type CanvasFrame,
} from '@mmstack/dnd';

/**
 * CMMN-style containment: stages are containers; tasks live inside a stage
 * (frames parent-relative) or at the root. Dragging a task over another stage
 * reparents it — the controller hands back REBASED frames and the consumer
 * applies membership + frame in one write.
 */
type Node = {
  id: string;
  label: string;
  kind: 'stage' | 'task';
  parent: string | null;
  frame: CanvasFrame;
};

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-canvas-containers-example',
  imports: [Canvas, CanvasItem],
  template: `
    <main>
      <h1>Canvas containment — stages and reparenting</h1>
      <p class="hint">
        Drag a task between stages (or out to the canvas root). The drop
        container highlights; frames rebase into the new parent's space.
      </p>

      <div class="viewport" data-canvas="stages" [mmCanvas]="ctrl">
        @for (n of roots(); track n.id) {
          @if (n.kind === 'stage') {
            <div
              class="stage"
              [class.hover]="ctrl.session.hoverContainer() === n.id"
              [attr.data-stage]="n.id"
              [mmCanvasItem]="n"
            >
              <span class="stage-label">{{ n.label }}</span>
              @for (t of childrenOf(n.id); track t.id) {
                <div class="task" [attr.data-task]="t.id" [mmCanvasItem]="t">
                  {{ t.label }}
                </div>
              }
            </div>
          } @else {
            <div class="task root" [attr.data-task]="n.id" [mmCanvasItem]="n">
              {{ n.label }}
            </div>
          }
        }
      </div>
      <p class="hint">
        Parents: <span data-testid="parents">{{ parentsLabel() }}</span>
      </p>
    </main>
  `,
  styles: `
    main {
      max-width: 860px;
      margin: 2rem auto;
      font-family: system-ui, sans-serif;
    }
    .hint {
      color: #666;
      font-size: 0.9rem;
    }
    .viewport {
      height: 420px;
      border: 1px solid #ddd;
      border-radius: 10px;
      overflow: hidden;
      background: #fafafa;
    }
    .stage {
      border: 2px dashed #b9c2d0;
      border-radius: 12px;
      background: rgb(255 255 255 / 0.75);
      box-sizing: border-box;
    }
    .stage.hover {
      border-color: #1971ff;
      background: rgb(25 113 255 / 0.06);
    }
    .stage-label {
      position: absolute;
      top: 6px;
      left: 10px;
      font-size: 0.75rem;
      font-weight: 700;
      color: #5a6b85;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      pointer-events: none;
    }
    .task {
      border-radius: 8px;
      background: #1971ff;
      color: #fff;
      font-weight: 600;
      display: grid;
      place-items: center;
      cursor: grab;
      font-size: 0.85rem;
    }
    .task.root {
      background: #7a4bd6;
    }
    .task.mm-canvas-dragging {
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
    }
  `,
})
export class CanvasContainersExample {
  private readonly data = signal<readonly Node[]>([
    {
      id: 'intake',
      label: 'Intake',
      kind: 'stage',
      parent: null,
      frame: { x: 30, y: 30, width: 320, height: 340 },
    },
    {
      id: 'review',
      label: 'Review',
      kind: 'stage',
      parent: null,
      frame: { x: 420, y: 30, width: 320, height: 340 },
    },
    {
      id: 't1',
      label: 'Collect vitals',
      kind: 'task',
      parent: 'intake',
      frame: { x: 30, y: 50, width: 130, height: 50 },
    },
    {
      id: 't2',
      label: 'History form',
      kind: 'task',
      parent: 'intake',
      frame: { x: 60, y: 140, width: 130, height: 50 },
    },
    {
      id: 't3',
      label: 'Sign-off',
      kind: 'task',
      parent: null,
      frame: { x: 350, y: 390 - 60, width: 110, height: 44 },
    },
  ]);

  readonly ctrl = injectCanvas<Node, string>(this.data, {
    key: (n) => n.id,
    frame: (n) => n.frame,
    patch: (n, frame) => ({ ...n, frame }),
    canTransform: (n, mode) => n.kind === 'task' || mode !== 'rotate',
    containers: {
      isContainer: (n) => n.kind === 'stage',
      containerOf: (n) => n.parent,
      canContain: (container, item) =>
        item.kind === 'task' && container.id !== item.id,
    },
    onReparent: ({ patches, container }) => {
      this.data.update((arr) =>
        arr.map((n) => {
          const frame = patches.get(n.id);
          return frame ? { ...n, frame, parent: container } : n;
        }),
      );
    },
    resize: false,
    marquee: false,
  });

  readonly roots = computed(() => {
    const items = this.ctrl.items();
    return [
      ...items.filter((n) => n.kind === 'stage'),
      ...items.filter((n) => n.kind === 'task' && n.parent === null),
    ];
  });

  childrenOf(stage: string): readonly Node[] {
    return this.ctrl.items().filter((n) => n.parent === stage);
  }

  readonly parentsLabel = computed(() =>
    this.ctrl
      .items()
      .filter((n) => n.kind === 'task')
      .map((n) => `${n.id}→${n.parent ?? 'root'}`)
      .join(' '),
  );
}
