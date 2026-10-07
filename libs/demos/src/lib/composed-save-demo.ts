import {
  HttpClient,
  HttpErrorResponse,
  type HttpEvent,
  HttpHandler,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Component, Injectable, linkedSignal, signal } from '@angular/core';
import {
  guessable,
  injectStartTransaction,
  injectTransitionScope,
  MmSuspenseError,
  provideTransitionScope,
  transactional,
  UnscopedSuspenseBoundary,
} from '@mmstack/primitives';
import { mutationResource, queryResource } from '@mmstack/resource';
import { Observable } from 'rxjs';

type Profile = { name: string };
const NAMES = ['Ana Ruiz', 'Ana R. Cole'];
const ADDRESSES = ['Main St 1', 'Harbour Rd 7'];

// A stand-in server for this demo only. The first address save fails.
@Injectable()
class FakeShopServer extends HttpHandler {
  private addressAttempts = 0;

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const body = this.answer(req);
    return new Observable((sub) => {
      const t = setTimeout(() => {
        if (body instanceof HttpErrorResponse) return sub.error(body);
        sub.next(new HttpResponse({ status: 200, body }));
        sub.complete();
      }, 400);
      return () => clearTimeout(t);
    });
  }

  private answer(req: HttpRequest<unknown>): unknown {
    if (req.url === '/api/profile') return { name: NAMES[0] };
    if (req.url === '/api/orders') {
      const to = req.params.get('address');
      return [`#101 to ${to}`, `#102 to ${to}`];
    }
    if (req.url === '/api/address' && ++this.addressAttempts === 1)
      return new HttpErrorResponse({ status: 500, url: req.url });
    return req.body;
  }
}

@Component({
  selector: 'demo-composed-save',
  imports: [UnscopedSuspenseBoundary, MmSuspenseError],
  providers: [
    provideTransitionScope(),
    HttpClient,
    FakeShopServer,
    { provide: HttpHandler, useExisting: FakeShopServer },
  ],
  template: `
    <button type="button" (click)="save()">Save name &amp; address</button>
    <mm-unscoped-suspense class="card">
      <span placeholder class="muted">Loading…</span>
      <span busy class="muted saving">saving…</span>
      <strong>{{ shownName() }}</strong>
      <p class="muted">Ships to {{ shownAddress() }}</p>
      <ul>
        @for (o of shownOrders() ?? []; track o) {
          <li>{{ o }}</li>
        }
      </ul>
      <p failed class="banner" *mmSuspenseError="let entries">
        @for (e of entries; track e.member.id) {
          {{ e.failure.displayName }} failed. Save again to retry.
        }
      </p>
    </mm-unscoped-suspense>
  `,
  styles: `
    button {
      font: inherit;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
    }

    .card {
      display: block;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
    }

    .saving {
      margin-right: 0.5rem;
    }

    .muted {
      margin: 0.25rem 0;
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    ul {
      margin: 0.25rem 0 0;
      padding-left: 1.1rem;
      font-size: 0.9rem;
    }

    .banner {
      margin: 0.5rem 0 0;
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--danger-line, #e2a8a5);
      background: var(--danger-soft, #fdecea);
      color: var(--danger-fg, #8a1c1c);
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
export class ComposedSaveDemo {
  private readonly startTransaction = injectStartTransaction();
  private readonly scope = injectTransitionScope();
  private readonly opts = { register: 'suspend', keepPrevious: true } as const;

  // two queries under one boundary
  readonly profile = queryResource<Profile>(() => '/api/profile', this.opts);
  readonly address = transactional(signal(ADDRESSES[0]));
  readonly ordersFor = signal(ADDRESSES[0]); // the debounced copy the query reads
  readonly orders = queryResource<string[]>(
    () => ({ url: '/api/orders', params: { address: this.ordersFor() } }),
    { ...this.opts, displayName: 'orders' },
  );

  // two writes, registered so their failures land in the boundary
  readonly rename = mutationResource<Profile, Profile, Profile>(
    (body) => ({ url: '/api/rename', method: 'POST', body }),
    { register: 'indicator', displayName: 'rename', retry: 0 },
  );
  readonly setAddress = mutationResource<string, string, string>(
    (body) => ({ url: '/api/address', method: 'POST', body }),
    {
      register: 'indicator',
      displayName: 'default address',
      retry: 0,
      invalidates: ['/api/orders'],
    },
  );

  // a live guess sits on the name; the screen reads held values
  readonly name = guessable(
    linkedSignal(() => this.profile.value()?.name ?? ''),
  );
  readonly shownName = this.scope.hold(this.name);
  readonly shownAddress = this.scope.hold(this.address);
  readonly shownOrders = this.scope.hold(this.orders.value);

  save() {
    const nextName = NAMES[(NAMES.indexOf(this.name()) + 1) % NAMES.length];
    const nextAddress =
      ADDRESSES[(ADDRESSES.indexOf(this.address()) + 1) % ADDRESSES.length];
    this.startTransaction(async (tx) => {
      tx.guess(this.name, nextName); // shows at once, gone when this settles
      const saved = await this.rename.mutateAsync({ name: nextName });
      tx.set(this.name, saved.name); // the truth, recorded
      try {
        await this.setAddress.mutateAsync(nextAddress);
      } catch {
        return; // the failure stays in errored(), the old list stays up
      }
      tx.set(this.address, nextAddress);
      const release = tx.retain(); // the orders refresh is debounced
      setTimeout(() => {
        try {
          tx.set(this.ordersFor, nextAddress);
        } finally {
          release();
        }
      }, 300);
    });
  }
}
