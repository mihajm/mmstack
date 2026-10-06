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
    @if (like.lastFailure(); as f) {
      <p class="banner">
        Save #{{ f.generation }} failed, the guess went back to the truth.
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
      color: #c2185b;
      border-color: #c2185b;
    }

    .muted {
      color: var(--fg-muted, #6b7280);
      font-size: 0.85rem;
    }

    .banner {
      margin: 0.75rem 0 0;
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      background: var(--danger-soft, #fdecea);
      font-size: 0.85rem;
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
