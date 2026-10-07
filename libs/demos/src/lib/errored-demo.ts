import { Component, computed, input, signal } from '@angular/core';
import { MmErrored } from '@mmstack/primitives';

@Component({
  selector: 'demo-errored-note',
  template: `
    <label>
      Note for the order
      <textarea
        rows="2"
        [value]="note()"
        (input)="note.set($any($event.target).value)"
      ></textarea>
    </label>
    <p class="total">Total: {{ total() }}</p>
  `,
  styles: `
    label {
      display: grid;
      gap: 0.25rem;
      font-size: 0.85rem;
    }

    textarea {
      font: inherit;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      resize: vertical;
    }

    .total {
      margin: 0.5rem 0 0;
      font-size: 0.85rem;
    }
  `,
})
export class ErroredNote {
  readonly broken = input(false);
  protected readonly note = signal('');

  // Throws during change detection, the way a bad binding would.
  protected readonly total = computed(() => {
    if (this.broken()) throw new Error('The price came back as NaN');
    return '42.00 EUR';
  });
}

// angular-eslint cannot parse `@boundary` yet; a template held in a const is not linted.
const TEMPLATE = `
  <div class="bar">
    <button type="button" (click)="broken.set(true)" [disabled]="broken()">
      Break the price
    </button>
    <span class="hint">Type a note first, then break it.</span>
  </div>
  <div class="compare">
    <div>
      <p class="caption">&#64;boundary, rebuilds on reset</p>
      <div class="card">
        @boundary {
          <demo-errored-note [broken]="broken()" />
        } @error {
          <p class="fallback">
            Something broke.
            <button type="button" (click)="broken.set(false); $reset()">
              Fix &amp; retry
            </button>
          </p>
        }
      </div>
    </div>
    <div>
      <p class="caption">*mmErrored, keeps the instance</p>
      <div class="card">
        <div *mmErrored="fallback; name: 'order note'">
          <demo-errored-note [broken]="broken()" />
        </div>
      </div>
    </div>
  </div>
  <p class="caption note">
    Each break also logs the error to the console, on purpose.
  </p>
  <ng-template #fallback let-error let-retry="retry">
    <p class="fallback">
      {{ error.message }}.
      <button type="button" (click)="broken.set(false); retry()">
        Fix &amp; retry
      </button>
    </p>
  </ng-template>
`;

@Component({
  selector: 'demo-errored',
  imports: [MmErrored, ErroredNote],
  template: TEMPLATE,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      margin-bottom: 1rem;
    }

    .bar button,
    .fallback button {
      padding: 0.3rem 0.75rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      background: var(--bg, #fff);
      font: inherit;
      font-size: 0.85rem;
      white-space: nowrap;
      color: var(--fg, #161616);
      cursor: pointer;
    }

    .bar button:disabled {
      color: var(--fg-muted, #6b7280);
      border-style: dashed;
      cursor: default;
    }

    .hint,
    .caption {
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
    }

    .caption {
      margin: 0 0 0.5rem;
    }

    .note {
      margin: 0.75rem 0 0;
    }

    .compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .card {
      min-height: 7rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .fallback {
      margin: 0;
      font-size: 0.85rem;
    }

    @media (max-width: 600px) {
      .compare {
        grid-template-columns: 1fr;
      }
    }

    @media (pointer: coarse) {
      button,
      select,
      input:not([type='checkbox']) {
        min-height: 44px;
      }

      label:has(input[type='checkbox']) {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        min-height: 44px;
      }

      input[type='checkbox'] {
        width: 1.25rem;
        height: 1.25rem;
        margin: 0;
      }
    }
  `,
})
export class ErroredDemo {
  protected readonly broken = signal(false);
}
