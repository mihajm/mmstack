import {
  HttpClient,
  HttpErrorResponse,
  type HttpEvent,
  HttpHandler,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Component, Injectable, signal } from '@angular/core';
import { guessable, provideTransitionScope } from '@mmstack/primitives';
import { mutationResource } from '@mmstack/resource';
import { Observable } from 'rxjs';

type Like = { on: boolean };

// A stand-in server for this demo only: slow, and it fails every second request.
@Injectable()
class FakeLikeServer extends HttpHandler {
  private attempt = 0;

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const n = ++this.attempt;
    return new Observable((sub) => {
      const t = setTimeout(() => {
        if (n % 2 === 0) {
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
      }, 900);
      return () => clearTimeout(t);
    });
  }
}

@Component({
  selector: 'demo-optimistic-like',
  providers: [
    provideTransitionScope(),
    HttpClient,
    FakeLikeServer,
    { provide: HttpHandler, useExisting: FakeLikeServer },
  ],
  template: `
    <div class="row">
      <button
        type="button"
        class="like"
        [class.on]="liked()"
        [attr.aria-pressed]="liked()"
        (click)="toggle()"
      >
        {{ liked() ? '♥ Liked' : '♡ Like' }}
      </button>
      <span class="muted">
        on screen: {{ liked() }}, truth: {{ liked.truth() }}
        @if (like.isLoading()) {
          , saving…
        }
      </span>
    </div>
    @if (like.lastFailure()) {
      <p class="banner">
        That save failed, so the guess went back to the truth.
      </p>
    }
    <p class="muted">Every second request to the server fails.</p>
  `,
  styles: `
    .row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .like {
      padding: 0.35rem 0.9rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 999px;
      background: var(--bg, #fff);
      font: inherit;
      cursor: pointer;
    }

    .like.on {
      color: light-dark(#c2185b, #f48fb1);
      border-color: currentColor;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .banner {
      margin: 0.75rem 0 0;
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
export class OptimisticLikeDemo {
  protected readonly liked = guessable(signal(false));

  protected readonly like = mutationResource<Like, Like, Like>(
    (body) => ({ url: '/api/posts/1/like', method: 'POST', body }),
    {
      retry: 0,
      // the guess is gone when the run settles, however it settles
      optimistic: (v, tx) => tx.guess(this.liked, v.on),
      onSuccess: (res) => this.liked.set(res.on), // the server's answer
    },
  );

  protected toggle() {
    this.like.mutate({ on: !this.liked() });
  }
}
