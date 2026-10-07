import {
  HttpClient,
  HttpErrorResponse,
  type HttpEvent,
  HttpHandler,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Component, inject, Injectable, input, signal } from '@angular/core';
import {
  MmRetryFailed,
  MmSuspenseError,
  SuspenseBoundary,
} from '@mmstack/primitives';
import { queryResource } from '@mmstack/resource';
import { Observable } from 'rxjs';

type Orders = { attempt: number };

// A stand-in server for this demo only: counts attempts per URL and fails the one named by
// the `failOn` query param with a 500.
@Injectable()
class FakeOrdersServer extends HttpHandler {
  private readonly attempts = new Map<string, number>();

  reset() {
    this.attempts.clear();
  }

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const attempt = (this.attempts.get(req.urlWithParams) ?? 0) + 1;
    this.attempts.set(req.urlWithParams, attempt);
    const failOn = Number(req.params.get('failOn'));
    return new Observable((sub) => {
      const t = setTimeout(() => {
        if (attempt === failOn) {
          sub.error(
            new HttpErrorResponse({
              status: 500,
              statusText: 'Internal Server Error',
              url: req.urlWithParams,
            }),
          );
          return;
        }
        sub.next(new HttpResponse({ status: 200, body: { attempt } }));
        sub.complete();
      }, 600);
      return () => clearTimeout(t);
    });
  }
}

@Component({
  selector: 'demo-orders-panel',
  template: `
    <strong>Orders</strong>
    <span class="muted">loaded on attempt {{ orders.value()?.attempt }}</span>
    <button type="button" (click)="orders.reload()">Reload</button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
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
export class OrdersPanel {
  readonly failOn = input.required<number>();
  readonly run = input.required<number>();

  protected readonly orders = queryResource<Orders>(
    () => ({
      url: '/api/orders',
      params: { failOn: this.failOn(), run: this.run() },
    }),
    {
      register: 'suspend',
      displayName: 'orders',
      keepPrevious: true,
      retry: 0,
    },
  );
}

@Component({
  selector: 'demo-failed-load',
  imports: [SuspenseBoundary, OrdersPanel, MmRetryFailed, MmSuspenseError],
  providers: [
    HttpClient,
    FakeOrdersServer,
    { provide: HttpHandler, useExisting: FakeOrdersServer },
  ],
  template: `
    <div class="bar">
      <button type="button" (click)="startOver()">Start over</button>
    </div>
    @for (r of [run()]; track r) {
      <div class="compare">
        @for (p of panels; track p.failOn) {
          <div>
            <p class="caption">{{ p.caption }}</p>
            <mm-suspense class="card">
              <span placeholder class="muted">Loading orders…</span>
              <p error class="muted">
                Could not load the orders.
                <button type="button" mmRetryFailed>Retry</button>
              </p>
              <div
                failed
                class="banner"
                *mmSuspenseError="let entries; retry as retry"
              >
                <span
                  >{{ entries[0].failure.displayName }} failed to refresh</span
                >
                <button type="button" (click)="retry()">Retry</button>
              </div>
              <demo-orders-panel [failOn]="p.failOn" [run]="r" />
            </mm-suspense>
          </div>
        }
      </div>
    }
  `,
  styles: `
    .bar {
      margin-bottom: 1rem;
    }

    button {
      font: inherit;
      font-size: 0.85rem;
    }

    .compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .caption {
      margin: 0 0 0.5rem;
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
    }

    .card {
      display: block;
      min-height: 4.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .muted {
      margin: 0;
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .banner {
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
export class FailedLoadDemo {
  private readonly server = inject(FakeOrdersServer);
  protected readonly run = signal(0);
  protected readonly panels = [
    { failOn: 1, caption: 'The first load fails: nothing to show' },
    { failOn: 2, caption: 'Hit Reload: the second load fails' },
  ];

  protected startOver() {
    this.server.reset();
    this.run.update((r) => r + 1);
  }
}
