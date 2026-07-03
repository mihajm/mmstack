import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  signal,
} from '@angular/core';
import { injectPendingMutations, mutationResource } from '@mmstack/resource';

type Note = { text: string };

/**
 * E2E surface for `@mmstack/resource` mutation persistence: saves queue through a
 * persisted mutation, the pending count comes straight from `injectPendingMutations`,
 * and successful responses append to the synced list. The e2e drives it with real
 * offline emulation + a real IndexedDB (see playground-e2e/src/persistence.spec.ts).
 */
@Component({
  selector: 'mm-persistence-example',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Mutation persistence</h2>
    <!-- renders only after client hydration — the e2e gates interaction on it,
         since SSR HTML looks identical but has no listeners attached yet -->
    @if (ready()) {
      <p data-testid="ready">ready</p>
    }
    <input data-testid="note-input" value="note" #input />
    <button data-testid="save" (click)="save(input.value)">save</button>
    <p>
      pending: <span data-testid="pending-count">{{ pending.count() }}</span>
    </p>
    <ol data-testid="synced">
      @for (text of synced(); track $index) {
        <li>{{ text }}</li>
      }
    </ol>
  `,
})
export class PersistenceExample {
  protected readonly ready = signal(false);
  protected readonly synced = signal<string[]>([]);
  protected readonly pending = injectPendingMutations();

  constructor() {
    afterNextRender(() => this.ready.set(true));
  }

  private readonly saveNote = mutationResource<Note, Note, Note>(
    (body) => ({ url: '/api/notes', method: 'POST', body }),
    {
      queue: true, // per-key FIFO — the ordering the e2e asserts across a reload
      persist: { key: 'e2e-note' },
      onSuccess: (result) => this.synced.update((s) => [...s, result.text]),
    },
  );

  protected save(text: string): void {
    this.saveNote.mutate({ text });
  }
}
