import { Component, computed, effect, signal, untracked } from '@angular/core';
import { opLog, store, storeHistory, type OpBatch } from '@mmstack/primitives';
import {
  ConnectionControllerDirective,
  VflowComponent,
  type Connection,
  type Edge,
  type Node,
  type NodePositionChange,
} from 'ngx-vflow';

/**
 * The BPMN/CMMN integration recipe: the DOCUMENT lives in an @mmstack store;
 * ngx-vflow is the diagram shell (nodes, edges, handles, connection UX). The
 * seams:
 * - doc → vflow: nodes are minted once per doc node (vflow's per-node
 *   `point` signal is seeded from the doc and updated on doc changes, so
 *   undo/redo and remote ops move nodes on screen);
 * - vflow → doc: `nodesChanges.position` marks drags dirty and the drag END
 *   commits the final point in ONE store write — one op batch per gesture,
 *   exactly like the first-party canvas.
 */
type FlowDoc = {
  nodes: Record<string, { label: string; x: number; y: number }>;
  edges: { id: string; source: string; target: string }[];
};

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'app-vflow-store-example',
  imports: [VflowComponent, ConnectionControllerDirective],
  template: `
    <main>
      <h1>ngx-vflow × store — the workflow-editor seam</h1>
      <p class="hint">
        Drag nodes, connect handles. The document is an @mmstack store: a drag
        commits once on release (watch the batch count), undo restores it, and
        new connections append edges.
      </p>

      <p class="toolbar">
        <button data-testid="undo" (click)="undo()" [disabled]="!history.canUndo()">
          Undo
        </button>
        <span data-testid="batch-count">{{ batches().length }} batches</span>
        <span data-testid="edge-count">{{ doc.edges().length }} edges</span>
      </p>

      <div class="flow">
        <vflow
          view="auto"
          background="#fafafa"
          [nodes]="nodes()"
          [edges]="edges()"
          (nodesChanges.position)="onMoved($event)"
          (nodeDragEnd)="commitPositions()"
          (connect)="onConnect($event)"
        />
      </div>
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
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .flow {
      height: 420px;
      border: 1px solid #ddd;
      border-radius: 10px;
      overflow: hidden;
    }
  `,
})
export class VflowStoreExample {
  readonly doc = store<FlowDoc>({
    nodes: {
      start: { label: 'Start', x: 60, y: 80 },
      triage: { label: 'Triage', x: 260, y: 40 },
      done: { label: 'Done', x: 460, y: 120 },
    },
    edges: [{ id: 'e1', source: 'start', target: 'triage' }],
  });
  readonly history = storeHistory(this.doc);
  readonly batches = signal<readonly OpBatch[]>([]);

  /** vflow Node objects, minted once per doc node id (signal-in-signal). */
  private readonly mint = new Map<string, Node>();
  readonly nodes = computed<Node[]>(() => {
    const doc = this.doc.nodes();
    const out: Node[] = [];
    for (const [id, n] of Object.entries(doc)) {
      let node = this.mint.get(id);
      if (!node) {
        node = {
          id,
          type: 'default',
          text: signal(n.label),
          point: signal({ x: n.x, y: n.y }),
        };
        this.mint.set(id, node);
      }
      out.push(node);
    }
    for (const id of [...this.mint.keys()]) {
      if (!(id in doc)) this.mint.delete(id);
    }
    return out;
  });

  readonly edges = computed<Edge[]>(() =>
    this.doc.edges().map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    })),
  );

  /** node ids whose position changed during the in-flight drag */
  private readonly dirty = new Set<string>();

  onMoved(changes: NodePositionChange[] | NodePositionChange): void {
    for (const c of Array.isArray(changes) ? changes : [changes]) {
      this.dirty.add(c.id);
    }
  }

  /** ONE store write per drag → one op batch / one undo entry. */
  commitPositions(): void {
    if (!this.dirty.size) return;
    for (const id of this.dirty) {
      const node = this.mint.get(id);
      if (!node || !(id in untracked(this.doc.nodes))) continue;
      const target = this.doc.nodes[id];
      const p = untracked(node.point);
      target.set({ ...untracked(target), x: p.x, y: p.y });
    }
    this.dirty.clear();
  }

  private edgeSeq = 2;

  onConnect(c: Connection): void {
    this.doc.edges.set([
      ...untracked(this.doc.edges),
      { id: `e${this.edgeSeq++}`, source: c.source, target: c.target },
    ]);
  }

  undo(): void {
    this.history.undo();
  }

  constructor() {
    opLog(this.doc, { origin: 'playground' }).subscribe((b) =>
      this.batches.update((all) => [...all, b]),
    );
    // doc → vflow: undo/remote ops move the rendered nodes
    effect(() => {
      const doc = this.doc.nodes();
      for (const [id, n] of Object.entries(doc)) {
        const node = this.mint.get(id);
        if (!node) continue;
        const p = untracked(node.point);
        if (p.x !== n.x || p.y !== n.y) node.point.set({ x: n.x, y: n.y });
      }
    });
  }
}
