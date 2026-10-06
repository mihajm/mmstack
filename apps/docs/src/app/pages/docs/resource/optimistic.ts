import { Component } from '@angular/core';
import { OptimisticLikeDemo } from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-optimistic',
  imports: [
    DocPage,
    DocSection,
    CodeExample,
    DemoBox,
    OptimisticLikeDemo,
    Link,
  ],
  template: `
    <docs-page
      title="Optimistic updates"
      pkg="@mmstack/resource"
      lead="Apply a change to the UI before the server confirms it, so the interaction feels instant, and roll it back cleanly if the request fails."
    >
      <p>
        A write that waits for the server before showing anything feels slow.
        The user clicks "like", nothing moves, and half a second later the count
        ticks up. Most of the time the server was going to succeed anyway, so
        you can show the result immediately and treat the request as
        confirmation rather than as the moment the change happens.
      </p>
      <p>
        The risk is the request that fails. If you have already changed the
        screen, you now have to put it back exactly the way it was.
        <code>mutationResource</code> gives you lifecycle hooks for both halves:
        one place to apply the change and record how to undo it, and one place
        that runs the undo when the request fails.
      </p>
      <p>
        There are two approaches. The lifecycle hooks below let you write real
        state and manage its rollback yourself. For temporary guesses that are
        removed automatically when an operation settles, start with
        <a mmLink="/docs/resource/optimistic" fragment="guesses"
          >the optimistic option</a
        >. It manages the guesses through success, failure, and cancellation.
      </p>

      <docs-section title="The lifecycle hooks" id="hooks">
        <p>
          A mutation runs through up to four hooks, and the value returned from
          the first one flows into the rest.
          <code>onMutate(value, initialCtx?)</code> fires synchronously before
          the request, applies the optimistic change, and returns a context
          value (typically the previous state) that the later hooks receive.
          <code>onError(err, ctx, meta)</code> fires on failure and uses that
          context to roll back. <code>onSuccess(saved, ctx)</code> fires on
          success and reconciles the optimistic guess with what the server
          actually stored. <code>onSettled(ctx)</code> runs after either branch,
          for cleanup.
        </p>
        <p>
          Here is the manual rollback pattern. A signal holds the current value,
          <code>onMutate</code> patches it and returns the previous value as the
          context, <code>onError</code> restores that previous value, and
          <code>onSuccess</code> replaces the guess with server truth.
        </p>
        <docs-code [code]="lifecycle" lang="ts" />
        <p>
          Read the previous value with <code>untracked()</code> so you are not
          creating a reactive dependency inside the hook. The context type is
          yours to choose: it can be the whole previous value, a small patch, or
          an object with several fields if a single mutation touches more than
          one signal.
        </p>
      </docs-section>

      <docs-section title="Patching a cached list" id="list">
        <p>
          The same pattern applies to a list read through
          <a mmLink="/docs/resource/query">queryResource</a>. Its
          <code>value</code> is a writable signal, so an optimistic add or
          remove is just a write. <code>onMutate</code> appends the new item and
          returns the list as it was, and <code>onError</code> writes that list
          back.
        </p>
        <docs-code [code]="listPatch" lang="ts" />
        <p>
          Reconciling by hand in <code>onSuccess</code> works, but for a cached
          list there is usually a cleaner move: let the server win by
          refetching.
        </p>
      </docs-section>

      <docs-section
        title="Let the server win with invalidates"
        id="invalidates"
      >
        <p>
          Your optimistic entry is a guess. The server assigns the real id, the
          real timestamps, maybe a normalized field or two. Instead of
          reconciling every field in <code>onSuccess</code>, declare which
          cached queries should refetch after a success with the
          <code>invalidates</code> option. The related queries refetch, and the
          canonical server data replaces your guess.
        </p>
        <docs-code [code]="invalidates" lang="ts" />
        <p>
          Each string is a URL prefix matched against the request URL of every
          cached entry, regardless of HTTP method, so a POST and its list GET
          are both covered. Pass a function form when the URLs depend on the
          result, for example invalidating a specific author's page after saving
          their post. This keeps <code>onMutate</code> and
          <code>onError</code> as your instant-feedback path, and hands the
          correctness of the final state to the refetch.
        </p>
      </docs-section>

      <docs-section title="Recipe: add to a list with rollback" id="recipe">
        <p>
          Putting it together for an "add" button: the item shows up the moment
          the user clicks, a failed request removes it again, and a success
          refetches the list so the optimistic row is replaced by the stored one
          with its real id.
        </p>
        <docs-code [code]="recipe" lang="ts" />
        <p>
          The user sees the row appear instantly. If the request fails they see
          it vanish and can retry. If it succeeds, the visible row quietly
          becomes the server's version on the next refetch, id and all.
        </p>
      </docs-section>

      <docs-section title="Guesses that revert by themselves" id="guesses">
        <p>
          The hooks above are write-then-rollback: you write the guess into real
          state and you're the one who has to put it back. The
          <code>optimistic</code> option turns that around. Each run opens a
          transaction on the nearest transition scope and passes it to you with
          the mutation value. A guess laid on that transaction is never the
          truth, and it's gone when the run settles, whether the request
          succeeded, failed, was superseded by a newer <code>mutate()</code> or
          the component was destroyed. A failed POST can't leave a phantom row
          behind, because there's no undo to forget.
        </p>
        <docs-code [code]="guessEx" lang="ts" />
        <p>
          The demo's server fails every second request. Like, and the button
          flips at once while the truth catches up when the answer lands.
          Unlike, and the guess shows until the failure comes back, then the
          button returns to the truth and <code>lastFailure()</code> says so.
        </p>
        <docs-demo title="A like that fails every other time">
          @defer (on viewport) {
            <demo-optimistic-like />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          Guesses come in two tiers from
          <a mmLink="/docs/primitives/transitions">&#64;mmstack/primitives</a>,
          and there is no default. <code>tx.guess(node, value)</code> on a
          <code>guessable(signal)</code> is the live tier: the guess shows in
          place, over a truth kept beneath it, and every reader sees it, derived
          values and request functions included. Use it when the write almost
          always succeeds, a like toggle say. <code>tx.overlay(view)</code> on
          an <code>optimistic(sig)</code> or
          <code>optimisticStore(base)</code> is the overlay tier: each run gets
          its own fork that only readers of the view see, and it is thrown away
          at the end, never written back. Use it for multi-field edits like a
          modal form or a draft editor, where the rest of the app shouldn't
          react to half-finished values.
        </p>
        <p>
          So which to pick, the hooks or <code>optimistic</code>? The hooks fit
          when the optimistic write is really the new state and you just need an
          undo for the failure case. <code>optimistic</code> fits when the value
          on screen is a stand-in for an answer that arrives by another path
          (<code>onSuccess</code>, an <code>invalidates</code> refetch): on
          success the run waits for those to land before the guess goes, so the
          screen moves from the guess to fresh data, not back to the old value
          first.
        </p>
        <p>
          Two things to know. While a run is open it holds the nearest scope's
          display like any transaction does, so held readers and
          <code>*mmTransition</code> swaps in that scope wait for the save too.
          And a request built from a live guess fires like any other request; if
          that isn't wanted, have the request function return
          <code>undefined</code> while the input is provisional.
        </p>
      </docs-section>

      <docs-section title="Replays reach these hooks too" id="replays">
        <p>
          Optimistic mutations that are queued or persisted for offline delivery
          replay when the network comes back, and they run through this same
          lifecycle. When a replay fails, <code>onError</code> receives a
          <code>meta</code> argument of
          <code>{{ '{' }} replayed: true {{ '}' }}</code
          >, so your rollback and reconcile policy still applies. That is worth
          knowing here because a replayed <code>onMutate</code> may run against
          a different current state than the one the user saw when they
          triggered it. See
          <a mmLink="/docs/resource/offline">offline and reconnection</a> for
          how queuing and persistence work and how replays are ordered.
        </p>
      </docs-section>
    </docs-page>
  `,
  styles: `
    .defer-hint {
      color: var(--fg-muted);
      font-size: 0.9rem;
      margin: 0;
    }
  `,
})
export class OptimisticDoc {
  protected readonly guessEx = `import { signal } from '@angular/core';
import { guessable } from '@mmstack/primitives';
import { mutationResource } from '@mmstack/resource';

readonly liked = guessable(signal(false));

readonly like = mutationResource(
  (on: boolean) => ({ url: \`/api/posts/\${id}/like\`, method: 'POST', body: { on } }),
  {
    optimistic: (on, tx) => tx.guess(this.liked, on), // every reader sees it now
    onSuccess: (res) => this.liked.set(res.on), // the server's answer replaces the guess
  },
);`;

  protected readonly lifecycle = `import { untracked } from '@angular/core';
import { mutationResource } from '@mmstack/resource';

const rename = mutationResource<User, User, string, User>(
  (name) => ({ url: \`/api/users/\${userId()}\`, method: 'PATCH', body: { name } }),
  {
    onMutate: (name) => {
      const prev = untracked(user.value); // ctx for rollback
      user.update((u) => ({ ...u, name }));
      return prev;
    },
    onError: (_err, prev) => user.set(prev), // put it back
    onSuccess: (saved) => user.set(saved), // reconcile with server truth
    onSettled: () => toast.dismiss('saving'),
  },
);`;

  protected readonly listPatch = `const addPost = mutationResource<Post, Post, Post, Post[]>(
  (post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    onMutate: (post) => {
      const prev = untracked(posts.value);
      posts.set([...prev, post]); // show it immediately
      return prev;
    },
    onError: (_err, prev) => posts.set(prev), // roll the list back
  },
);`;

  protected readonly invalidates = `const addPost = mutationResource<Post, Post, Post, Post[]>(
  (post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    onMutate: (post) => {
      const prev = untracked(posts.value);
      posts.set([...prev, post]);
      return prev;
    },
    onError: (_err, prev) => posts.set(prev),
    invalidates: ['/api/posts'], // refetch on success; server data replaces the guess
    // or derived from the result:
    // invalidates: (saved) => ['/api/posts', \`/api/users/\${saved.authorId}\`],
  },
);`;

  protected readonly recipe = `const addPost = mutationResource<Post, Post, NewPost, Post[]>(
  (draft) => ({ url: '/api/posts', method: 'POST', body: draft }),
  {
    onMutate: (draft) => {
      const prev = untracked(posts.value);
      // a temporary local shape until the server assigns the real one
      posts.set([...prev, { ...draft, id: 'pending' } as Post]);
      return prev;
    },
    onError: (_err, prev) => posts.set(prev),
    invalidates: ['/api/posts'], // success -> list refetches, pending row becomes the stored one
  },
);

// in a click handler:
addPost.mutate({ title, body });`;
}
