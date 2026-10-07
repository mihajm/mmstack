import {
  HttpClient,
  type HttpEvent,
  HttpErrorResponse,
  HttpHandler,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Component, inject, Injectable, signal } from '@angular/core';
import {
  MmSuspenseError,
  provideTransitionScope,
  UnscopedSuspenseBoundary,
} from '@mmstack/primitives';
import { mutationResource } from '@mmstack/resource';
import { Observable } from 'rxjs';

type Note = { text: string };

// A stand-in server for this demo only: answers after 700ms, or with a 500 while `reject` is on.
@Injectable()
class FakeNotesServer extends HttpHandler {
  readonly reject = signal(false);

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const fail = this.reject();
    return new Observable((sub) => {
      const t = setTimeout(() => {
        if (fail) {
          sub.error(
            new HttpErrorResponse({
              status: 500,
              statusText: 'Internal Server Error',
              url: req.url,
            }),
          );
          return;
        }
        sub.next(new HttpResponse({ status: 200, body: req.body }));
        sub.complete();
      }, 700);
      return () => clearTimeout(t);
    });
  }
}

@Component({
  selector: 'demo-failed-save',
  imports: [UnscopedSuspenseBoundary, MmSuspenseError],
  providers: [
    provideTransitionScope(),
    HttpClient,
    FakeNotesServer,
    { provide: HttpHandler, useExisting: FakeNotesServer },
  ],
  template: `
    <mm-unscoped-suspense class="card">
      <span busy class="muted busy">Saving…</span>
      <div class="bar">
        <input
          [value]="text()"
          (input)="text.set($any($event.target).value)"
          aria-label="Note"
        />
        <button type="button" (click)="save()">Save</button>
        <label
          ><input
            type="checkbox"
            [checked]="reject()"
            (change)="reject.set($any($event.target).checked)"
          />
          server rejects</label
        >
      </div>
      <p class="muted last">
        Last saved:
        {{ saved() === null ? 'nothing yet' : saved() || 'an empty note' }}
      </p>
      <div
        failed
        class="banner"
        *mmSuspenseError="let entries; dismissAll as dismissAll"
      >
        @for (e of entries; track e.member.id) {
          <span>{{ e.failure.displayName }}: {{ e.failure.message }}</span>
        }
        <button type="button" (click)="dismissAll()">Dismiss</button>
      </div>
    </mm-unscoped-suspense>
  `,
  styles: `
    /* fixed rows, so the busy text never pushes the input around */
    .card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: 0.75rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .bar {
      grid-row: 1;
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
    }

    .bar input:not([type]) {
      font: inherit;
      padding: 0.3rem 0.5rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
    }

    button {
      font: inherit;
      font-size: 0.85rem;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .last {
      grid-row: 2;
      grid-column: 1;
      margin: 0.75rem 0 0;
      overflow-wrap: anywhere;
    }

    .busy {
      grid-row: 2;
      grid-column: 2;
      align-self: end;
    }

    .banner {
      grid-row: 3;
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--danger-line, #e2a8a5);
      background: var(--danger-soft, #fdecea);
      color: var(--danger-fg, #8a1c1c);
      font-size: 0.85rem;
    }

    .banner button {
      flex-shrink: 0;
      padding: 0.1rem 0.6rem;
      border: 1px solid var(--danger-line, #e2a8a5);
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    .banner button:hover {
      border-color: currentColor;
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
export class FailedSaveDemo {
  protected readonly text = signal('Call the supplier');
  protected readonly saved = signal<string | null>(null);
  protected readonly reject = inject(FakeNotesServer).reject;

  // A registered mutation: it drives the busy slot while it runs, and a failure stays in
  // the boundary's errored() list until dismissed or the next save starts.
  protected readonly saveNote = mutationResource<Note, Note, Note>(
    (note: Note) => ({ url: '/api/notes', method: 'POST', body: note }),
    {
      register: 'indicator',
      displayName: 'Saving the note',
      retry: 0,
      onSuccess: (note) => this.saved.set(note.text),
    },
  );

  protected save() {
    this.saveNote.mutate({ text: this.text() });
  }
}
