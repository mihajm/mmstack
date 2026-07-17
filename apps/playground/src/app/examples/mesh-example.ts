// import {
//   ChangeDetectionStrategy,
//   Component,
//   computed,
//   Injector,
//   signal,
//   inject,
// } from '@angular/core';
// import { FormsModule } from '@angular/forms';
// import { createRelay } from '@mmstack/mesh-protocol';
// import {
//   directTransport,
//   meshSync,
//   type MeshSyncRef,
// } from '@mmstack/mesh';
// import {
//   keyedArray,
//   store,
//   storeHistory,
//   type StoreHistory,
//   type WritableSignalStore,
// } from '@mmstack/primitives';

// type Todo = { id: number; title: string; done: boolean };
// type Board = { title: string; todos: Todo[] };

// const initialBoard = (): Board => ({
//   title: 'Shared board',
//   todos: [
//     { id: 1, title: 'Try editing from both panels', done: false },
//     { id: 2, title: 'Toggle a checkbox on the left', done: false },
//   ],
// });

// // One in-page relay: both panels are independent meshSync clients talking to it, exactly as
// // two browser tabs would talk to a server. Nothing leaves the page.
// const relay = createRelay();

// type Panel = {
//   readonly writer: string;
//   readonly store: WritableSignalStore<Board>;
//   readonly mesh: ReturnType<typeof signal<MeshSyncRef>>;
//   readonly history: StoreHistory;
//   readonly connected: ReturnType<typeof signal<boolean>>;
// };

// @Component({
//   selector: 'mm-mesh-example',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   imports: [FormsModule],
//   template: `
//     <section>
//       <h2>Mesh multiplayer</h2>
//       <p class="hint">
//         Two independent clients, one in-page relay. Edit either side and watch it replicate.
//         Disconnect a panel, edit both, then reconnect to see the rebase.
//       </p>
//       <div class="panels">
//         @for (panel of panels; track panel.writer) {
//           <div class="panel" [class.offline]="!panel.connected()">
//             <header>
//               <b>{{ panel.writer }}</b>
//               <span class="status" [attr.data-s]="panel.mesh().status()">{{
//                 panel.mesh().status()
//               }}</span>
//               <span class="peers">peers: {{ panel.mesh().peers().length }}</span>
//             </header>

//             <input
//               class="title"
//               [ngModel]="panel.store.title()"
//               (ngModelChange)="panel.store.title.set($event)"
//               placeholder="board title"
//             />

//             <ul>
//               @for (todo of panel.store.todos(); track todo.id) {
//                 <li>
//                   <input
//                     type="checkbox"
//                     [ngModel]="todo.done"
//                     (ngModelChange)="setDone(panel, todo.id, $event)"
//                   />
//                   <input
//                     class="todo"
//                     [class.done]="todo.done"
//                     [ngModel]="todo.title"
//                     (ngModelChange)="setTitle(panel, todo.id, $event)"
//                   />
//                 </li>
//               }
//             </ul>

//             <div class="actions">
//               <button (click)="addTodo(panel)">+ todo</button>
//               <button [disabled]="!panel.history.canUndo()" (click)="panel.history.undo()">
//                 undo
//               </button>
//               <button [disabled]="!panel.history.canRedo()" (click)="panel.history.redo()">
//                 redo
//               </button>
//               <button (click)="toggleConnection(panel)">
//                 {{ panel.connected() ? 'disconnect' : 'reconnect' }}
//               </button>
//             </div>
//           </div>
//         }
//       </div>
//     </section>
//   `,
//   styles: `
//     section {
//       padding: 1rem;
//       font-family: system-ui, sans-serif;
//       color: #1e293b;
//     }
//     .hint {
//       color: #64748b;
//       max-width: 60ch;
//     }
//     .panels {
//       display: grid;
//       grid-template-columns: 1fr 1fr;
//       gap: 1rem;
//     }
//     .panel {
//       border: 1px solid #e2e8f0;
//       border-radius: 8px;
//       padding: 0.75rem;
//       transition: opacity 0.2s;
//     }
//     .panel.offline {
//       opacity: 0.55;
//     }
//     header {
//       display: flex;
//       align-items: center;
//       gap: 0.5rem;
//       margin-bottom: 0.5rem;
//     }
//     .status {
//       font-size: 0.75em;
//       padding: 0.1rem 0.4rem;
//       border-radius: 999px;
//       background: #dcfce7;
//       color: #166534;
//     }
//     .status[data-s='reconnecting'],
//     .status[data-s='connecting'] {
//       background: #fef9c3;
//       color: #854d0e;
//     }
//     .status[data-s='ejected'] {
//       background: #fee2e2;
//       color: #991b1b;
//     }
//     .peers {
//       margin-left: auto;
//       font-size: 0.75em;
//       color: #64748b;
//     }
//     input.title {
//       width: 100%;
//       font-weight: 600;
//       border: none;
//       border-bottom: 1px solid #e2e8f0;
//       padding: 0.25rem 0;
//       margin-bottom: 0.5rem;
//     }
//     ul {
//       list-style: none;
//       padding: 0;
//       margin: 0 0 0.5rem;
//     }
//     li {
//       display: flex;
//       align-items: center;
//       gap: 0.5rem;
//       padding: 0.15rem 0;
//     }
//     input.todo {
//       flex: 1;
//       border: none;
//       background: transparent;
//     }
//     input.todo.done {
//       text-decoration: line-through;
//       color: #94a3b8;
//     }
//     .actions {
//       display: flex;
//       gap: 0.4rem;
//       flex-wrap: wrap;
//     }
//     button {
//       font-size: 0.85em;
//       padding: 0.2rem 0.55rem;
//     }
//   `,
// })
// export class MeshExample {
//   private readonly injector = inject(Injector);

//   protected readonly panels: Panel[] = ['alice', 'bob'].map((writer) =>
//     this.createPanel(writer),
//   );

//   private createPanel(writer: string): Panel {
//     const s = store<Board>(initialBoard(), { injector: this.injector });
//     const connected = signal(true);
//     // per-item identity so concurrent edits to different todos merge instead of clobbering
//     const policies = [{ path: 'todos', merge: keyedArray((t) => (t as Todo).id) }];
//     const mesh = meshSync(s, {
//       room: 'demo-board',
//       writer,
//       transport: directTransport(relay, { writer }),
//       policies,
//       injector: this.injector,
//     });
//     const history = storeHistory(s, { origin: writer, injector: this.injector });
//     mesh.setPresence({ name: writer }); // announce so peers show up in the roster
//     return { writer, store: s, mesh: signal(mesh), history, connected };
//   }

//   protected setTitle(panel: Panel, id: number, title: string): void {
//     panel.store.todos.update((todos) =>
//       todos.map((t) => (t.id === id ? { ...t, title } : t)),
//     );
//   }

//   protected setDone(panel: Panel, id: number, done: boolean): void {
//     panel.store.todos.update((todos) =>
//       todos.map((t) => (t.id === id ? { ...t, done } : t)),
//     );
//   }

//   protected addTodo(panel: Panel): void {
//     const nextId = computed(() =>
//       panel.store.todos().reduce((m, t) => Math.max(m, t.id), 0) + 1,
//     )();
//     panel.store.todos.update((todos) => [
//       ...todos,
//       { id: nextId, title: 'New todo', done: false },
//     ]);
//   }

//   protected toggleConnection(panel: Panel): void {
//     if (panel.connected()) {
//       panel.mesh().close();
//       panel.connected.set(false);
//     } else {
//       // re-establish a fresh client on the same store (a real app would just reconnect the socket)
//       const fresh = meshSync(panel.store, {
//         room: 'demo-board',
//         writer: panel.writer,
//         transport: directTransport(relay, { writer: panel.writer }),
//         policies: [{ path: 'todos', merge: keyedArray((t) => (t as Todo).id) }],
//         injector: this.injector,
//       });
//       fresh.setPresence({ name: panel.writer });
//       panel.mesh.set(fresh);
//       panel.connected.set(true);
//     }
//   }
// }
