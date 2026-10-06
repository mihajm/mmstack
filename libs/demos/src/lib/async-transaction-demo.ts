import {
  Component,
  effect,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import {
  type AsyncTransactionRef,
  heldEffect,
  injectStartTransaction,
  injectTransitionScope,
  provideTransitionScope,
  transactional,
} from '@mmstack/primitives';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['Atlas', 'Borealis', 'Cobalt', 'Dune'];

@Component({
  selector: 'demo-async-transaction',
  providers: [provideTransitionScope()],
  template: `
    <div class="bar">
      <button type="button" (click)="save()" [disabled]="saving()">
        Rename &amp; save
      </button>
      <button type="button" (click)="ref?.abort()" [disabled]="!saving()">
        Abort
      </button>
      <label
        ><input
          type="checkbox"
          [checked]="fail()"
          (change)="fail.set($any($event.target).checked)"
        />
        server rejects</label
      >
      <span class="muted">{{ outcome() }}</span>
    </div>
    <div class="compare">
      <div class="card">
        <p class="caption">Live state</p>
        <strong>{{ name() }}</strong>
        <span class="muted">revision {{ revision() }}</span>
      </div>
      <div class="card">
        <p class="caption">On screen, held by the scope</p>
        <strong>{{ shownName() }}</strong>
        <span class="muted">revision {{ shownRevision() }}</span>
      </div>
      <div class="card">
        <p class="caption">effect() ran {{ plain().length }}x</p>
        @for (line of plain().slice(-3); track $index) {
          <span class="muted">{{ line }}</span>
        }
      </div>
      <div class="card">
        <p class="caption">heldEffect() ran {{ held().length }}x</p>
        @for (line of held().slice(-3); track $index) {
          <span class="muted">{{ line }}</span>
        }
      </div>
    </div>
  `,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }

    .bar button {
      padding: 0.3rem 0.75rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      background: var(--bg, #fff);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }

    .card {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      padding: 0.6rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .caption {
      margin: 0 0 0.25rem;
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class AsyncTransactionDemo {
  private readonly startTransaction = injectStartTransaction();
  private readonly scope = injectTransitionScope();

  // transactional() records each write so an abort can put it back
  protected readonly name = transactional(signal(NAMES[0]));
  protected readonly revision = transactional(signal(1));
  protected readonly shownName = this.scope.hold(this.name);
  protected readonly shownRevision = this.scope.hold(this.revision);

  protected readonly fail = signal(false);
  protected readonly saving = signal(false);
  protected readonly outcome = signal('');
  protected ref: AsyncTransactionRef | null = null;

  protected readonly plain = signal<string[]>([]);
  protected readonly held = signal<string[]>([]);

  constructor() {
    effect(() => this.log(this.plain));
    heldEffect(() => this.log(this.held));
  }

  private log(into: WritableSignal<string[]>) {
    const line = `${this.name()} r${this.revision()}`;
    untracked(() => into.update((l) => [...l, line]));
  }

  protected save() {
    const next = NAMES[(NAMES.indexOf(this.name()) + 1) % NAMES.length];
    this.saving.set(true);
    this.outcome.set('saving…');
    const ref = this.startTransaction(async (tx) => {
      this.name.set(next); // before the first await: part of the transaction
      await wait(1200);
      if (this.fail()) throw new Error('rejected');
      // after an await, re-enter so the write belongs to this transaction
      tx.enter(() => this.revision.update((r) => r + 1));
    });
    this.ref = ref;
    void ref.done.then((o) => {
      this.saving.set(false);
      this.outcome.set(o.kind === 'aborted' ? `aborted (${o.reason})` : o.kind);
    });
  }
}
