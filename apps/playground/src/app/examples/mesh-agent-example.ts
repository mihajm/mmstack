// import {
//   afterNextRender,
//   ChangeDetectionStrategy,
//   Component,
//   inject,
//   Injector,
//   signal,
// } from '@angular/core';
// import { meshSync, webSocketTransport, type MeshSyncRef } from '@mmstack/mesh';
// import { store, type WritableSignalStore } from '@mmstack/primitives';

// type Doc = { title: string; agent: { note: string } };

// /**
//  * E2E surface for "an agent is a user": a human and an agent share a room over the
//  * relay, which runs a path ACL (humans write the whole store, an agent is scoped to the
//  * `agent/*` subtree). One peer per page (writer + kind from the query string).
//  *
//  * The agent client carries NO emit-side policy on purpose: an honest client would refuse to
//  * emit an out-of-scope write, so omitting it lets the demo show the RELAY tripwire ejecting a
//  * misbehaving agent (see playground-e2e/src/mesh-agent.spec.ts).
//  */
// @Component({
//   selector: 'mm-mesh-agent-example',
//   changeDetection: ChangeDetectionStrategy.OnPush,
//   template: `
//     <h2>Agent as peer</h2>
//     @if (mesh(); as m) {
//       <p data-testid="status">{{ m.status() }}</p>
//     }
//     <p data-testid="title">{{ store.title() }}</p>
//     <p data-testid="note">{{ store.agent.note() }}</p>
//     <button
//       data-testid="write-title"
//       (click)="store.title.set('title-by-' + writer)"
//     >
//       write title (human-only path)
//     </button>
//     <button
//       data-testid="write-note"
//       (click)="store.agent.note.set('note-by-' + writer)"
//     >
//       write agent note
//     </button>
//   `,
// })
// export class MeshAgentExample {
//   private readonly injector = inject(Injector);
//   protected writer = 'anon';
//   protected readonly store: WritableSignalStore<Doc> = store<Doc>(
//     { title: 'shared', agent: { note: '' } },
//     { injector: this.injector },
//   );
//   protected readonly mesh = signal<MeshSyncRef | null>(null);

//   constructor() {
//     afterNextRender(() => {
//       const params = new URLSearchParams(location.search);
//       this.writer = params.get('writer') ?? 'anon';
//       const kind = params.get('kind') ?? 'human';
//       const transport = webSocketTransport(
//         `ws://${location.hostname}:4301/?writer=${this.writer}&kind=${kind}`,
//       );
//       this.mesh.set(
//         meshSync(this.store, {
//           room: 'agent-room',
//           writer: this.writer,
//           transport,
//           injector: this.injector,
//         }),
//       );
//     });
//   }
// }
