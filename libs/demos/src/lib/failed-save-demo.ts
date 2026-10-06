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
      <span busy class="muted">Saving…</span>
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
      <p class="muted">Last saved: {{ saved() || 'nothing yet' }}</p>
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
    .card {
      display: block;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .bar {
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

    .banner {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      background: var(--danger-soft, #fdecea);
      font-size: 0.85rem;
    }
  `,
})
export class FailedSaveDemo {
  protected readonly text = signal('Call the supplier');
  protected readonly saved = signal('');
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
