import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-mutation',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="mutationResource"
      pkg="@mmstack/resource"
      lead="The write. It fires only when you call mutate(value), and its lifecycle hooks give you optimistic updates that roll back on failure."
    >
      <p>
        A query keeps read data in sync on its own. A write is different: it's a
        command you issue at a moment you choose, on data the user just
        produced. So a mutation doesn't run reactively. It sits there until you
        call <code>mutate()</code>, sends the request, and reports how it went.
      </p>
      <p>
        The reason it's a dedicated resource and not a bare
        <code>HttpClient</code> call is the lifecycle around the request. Those
        hooks are what let you update the screen before the server answers and
        undo it cleanly if the server says no.
      </p>

      <docs-section title="Firing a mutation" id="mutate">
        <p>
          The request function receives the value you pass to
          <code>mutate()</code> and returns the request to send. A mutation
          cannot be cached, so it rejects the <code>cache</code>,
          <code>keepPrevious</code>, and <code>refresh</code> options by design.
        </p>
        <docs-code [code]="mutate" lang="ts" />
        <p>
          <code>mutate()</code> is fire-and-forget. When you need the outcome in
          line, for example to navigate after a save or to fail a validator, use
          <code>mutateAsync()</code>. It returns a promise that resolves with
          the result or rejects with the error.
        </p>
        <docs-code [code]="async" lang="ts" />
        <p>
          The <code>MutationCancelledError</code> guard matters here. If a
          mutation never completes (a newer one supersedes it, the component is
          destroyed, the queue is cleared), the promise rejects with that error
          rather than a real failure. An awaiter that isn't expecting
          cancellation should return early on it, as above.
        </p>
        <p>
          Because a mutation is a command, calling <code>mutate()</code> with a
          body identical to one already in flight is deduplicated, which doubles
          as double-click protection. When a repeat with the same body must fire
          anyway (a "resend" button, re-uploading the same file), set
          <code>triggerOnSameRequest: true</code> and every call goes through.
        </p>
      </docs-section>

      <docs-section title="Lifecycle hooks" id="hooks">
        <p>
          Four hooks run around the request. <code>onMutate</code> fires
          synchronously before it and can return a context value.
          <code>onError</code> and <code>onSuccess</code> fire on their
          respective branch and receive that context. <code>onSettled</code>
          runs after either one, for cleanup.
        </p>
        <docs-code [code]="hooks" lang="ts" />
        <p>
          The context returned from <code>onMutate</code> is the thread that
          ties them together. It flows into the later hooks, which is exactly
          what an optimistic update needs: stash the old state on the way in,
          restore it on failure.
        </p>
      </docs-section>

      <docs-section title="Optimistic update and rollback" id="optimistic">
        <p>
          This is the pattern the hooks were built for. Apply the change to a
          query's value in <code>onMutate</code> so the UI updates instantly,
          and return the previous value as context. If the request fails,
          <code>onError</code> restores it. On success, <code>onSuccess</code>
          swaps the optimistic entry for the real server record (which now has
          its id, timestamps, and so on).
        </p>
        <docs-code [code]="optimistic" lang="ts" />
        <p>
          Read the previous value with <code>untracked()</code>. Reading a
          signal inside <code>onMutate</code> without it would register a
          dependency you don't want. If reasoning about rollback by hand feels
          fiddly, the payoff is real: the interface never waits on the network
          for changes that almost always succeed. The
          <a mmLink="/docs/resource/optimistic">Optimistic updates</a> page goes
          further, including patching cached lists and how rollback behaves when
          a mutation replays after coming back online.
        </p>
      </docs-section>

      <docs-section title="Refreshing queries after a write" id="invalidates">
        <p>
          A write usually means some cached reads are now stale. Instead of
          reaching into the cache from <code>onSuccess</code> by hand, declare
          what to invalidate. After the mutation succeeds, every cached entry
          under those URL prefixes is dropped, so the next read refetches.
        </p>
        <docs-code [code]="invalidates" lang="ts" />
        <p>
          Strings are URL prefixes, matched against every cached entry
          regardless of HTTP method. You can also pass a function to derive the
          prefixes from the result, for example to also invalidate the affected
          user's page.
        </p>
        <p>
          Matching works by recovering the URL from the default key shape, so it
          keeps working even for keys a custom
          <a mmLink="/docs/resource/caching">cache.hash</a> merely prepends a
          namespace to. If your keys abandon that shape entirely, invalidation
          can't locate them. Teach it how with <code>invalidateMatcher</code>,
          which maps each invalidated URL prefix to a predicate over your custom
          keys. Set it per mutation, or globally through
          <code>provideMutationResourceOptions</code>.
        </p>
        <docs-code [code]="matcher" lang="ts" />
      </docs-section>

      <docs-section title="Queuing and offline" id="queue">
        <p>
          By default, calling <code>mutate()</code> while another is in flight
          starts it immediately, so writes run in parallel. With
          <code>queue: true</code> they serialize, one at a time. The queue
          survives disabled states: if the circuit breaker opens or the network
          drops, queued writes wait and run when the resource recovers.
        </p>
        <docs-code [code]="queue" lang="ts" />
        <p>
          That resilience has a flip side. A queued mutation can fire long after
          the user triggered it (the classic "POST goes out when we're back
          online"). Don't enable <code>queue</code> where that timing would
          surprise someone. Take it one step further with <code>persist</code>
          and accepted-but-unsettled writes survive an app close in IndexedDB
          and replay on the next launch, which is worth reading up on before you
          rely on it.
        </p>
        <p>
          When queued writes should be abandoned (the user leaves the flow, a
          draft is discarded), <code>clearQueue()</code> drops everything still
          pending. Any awaiter on a dropped mutation rejects with a
          <code>MutationCancelledError</code>, so the same guard from
          <code>mutateAsync</code> covers it.
        </p>
        <docs-code [code]="clearQueue" lang="ts" />
      </docs-section>

      <docs-section title="File uploads with progress" id="uploads">
        <p>
          There is no separate upload API. Return a <code>FormData</code> body
          and <code>HttpClient</code> sets the multipart boundary for you. Opt
          into progress events with <code>reportProgress: true</code> and read
          the <code>progress</code> signal.
        </p>
        <docs-code [code]="upload" lang="ts" />
      </docs-section>

      <docs-section title="Submit a form()" id="signal-forms">
        <p>
          Angular Signal Forms runs your write through
          <code>submit(form, action)</code>: the action runs only when the form
          is valid, and <code>submit</code> resolves to a boolean for whether it
          went through. The action is an ordinary async function, so
          <code>mutateAsync</code> drops straight in.
        </p>
        <docs-code [code]="formSubmit" lang="ts" />
        <p>
          On failure you have a choice. Return validation errors from the action
          and <code>submit</code> attaches them to the form (a bare
          <code>{{ '{' }} kind, message {{ '}' }}</code> lands on the form, or
          add a field to target one control), which is how you surface a server
          rejection like "email already taken" next to the input. Guard
          <code>MutationCancelledError</code> first so a superseded write is not
          reported as a real failure.
        </p>
        <p>
          When you only want to send what changed and re-baseline on success,
          <a mmLink="/docs/forms/change-tracking">&#64;mmstack/forms</a> ships
          <code>submitChanges</code>, which is this recipe wrapped up with a
          <code>mutationResource</code> as its target.
        </p>
      </docs-section>

      <docs-section title="The return shape" id="ref">
        <p>
          A mutation ref is deliberately narrower than a query's. It has no
          <code>value</code>, <code>hasValue</code>, or <code>prefetch</code>,
          because those don't make sense for a one-off write.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>mutate(value, ctx?)</code></td>
              <td>Trigger it, fire-and-forget.</td>
            </tr>
            <tr>
              <td><code>mutateAsync(value, ctx?)</code></td>
              <td>Trigger and await the result.</td>
            </tr>
            <tr>
              <td><code>current()</code></td>
              <td>The value being mutated, or <code>null</code> when idle.</td>
            </tr>
            <tr>
              <td><code>progress()</code></td>
              <td>Upload progress when <code>reportProgress: true</code>.</td>
            </tr>
            <tr>
              <td><code>clearQueue()</code></td>
              <td>
                Drop all pending queued mutations. Awaiters reject with
                <code>MutationCancelledError</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>status()</code> / <code>error()</code> /
                <code>isLoading()</code>
              </td>
              <td>The same status surface as a query.</td>
            </tr>
          </tbody>
        </table>
      </docs-section>
    </docs-page>
  `,
})
export class MutationResourceDoc {
  protected readonly mutate = `import { mutationResource } from '@mmstack/resource';

readonly createPost = mutationResource((post: Post) => ({
  url: '/api/posts',
  method: 'POST',
  body: post,
}));

// somewhere in a handler:
this.createPost.mutate(newPost);`;

  protected readonly async = `import { MutationCancelledError } from '@mmstack/resource';

async onSubmit(post: Post) {
  try {
    const saved = await this.createPost.mutateAsync(post);
    this.router.navigate(['/posts', saved.id]);
  } catch (e) {
    if (e instanceof MutationCancelledError) return; // never ran
    this.toast.error('Failed to save');
  }
}`;

  protected readonly formSubmit = `import { submit } from '@angular/forms/signals';
import { MutationCancelledError, mutationResource } from '@mmstack/resource';

readonly save = mutationResource(
  (user: User) => ({ url: '/api/users', method: 'POST', body: user }),
);

async onSubmit() {
  const saved = await submit(this.form, async () => {
    try {
      await this.save.mutateAsync(this.form().value());
    } catch (err) {
      if (err instanceof MutationCancelledError) return; // superseded, not a failure
      return { kind: 'server', message: 'Could not save. Try again.' };
    }
  });

  if (saved) this.router.navigate(['/users']);
}`;

  protected readonly hooks = `mutationResource((post: Post) => ({ url: '/api/posts', method: 'POST', body: post }), {
  onMutate: (post) => {
    // fires synchronously before the request; return a ctx value
    return 'anything';
  },
  onError: (err, ctx) => {
    // fires on failure; ctx is what onMutate returned
  },
  onSuccess: (saved, ctx) => {
    // fires on success
  },
  onSettled: (ctx) => {
    // fires after either branch; cleanup, refetch, etc.
  },
});`;

  protected readonly optimistic = `import { untracked } from '@angular/core';

readonly createPost = mutationResource(
  (post: Post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    onMutate: (post) => {
      const prev = untracked(this.posts.value);
      this.posts.set([...prev, post]); // apply optimistically
      return prev; // ctx for rollback, inferred & type-safe
    },
    onError: (_err, prev) => this.posts.set(prev), // roll back
    onSuccess: (saved) =>
      this.posts.update((posts) =>
        posts.map((p) => (p.id === saved.id ? saved : p)),
      ),
  },
);`;

  protected readonly invalidates = `readonly createPost = mutationResource(
  (post: Post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    invalidates: ['/api/posts'], // drop cached reads under this prefix

    // or derive from the result:
    // invalidates: (saved) => ['/api/posts', \`/api/users/\${saved.authorId}\`],
  },
);`;

  protected readonly queue = `readonly saveNote = mutationResource(
  (note: Note) => ({ url: '/api/notes', method: 'POST', body: note }),
  {
    queue: true, // serialize; hold pending while offline, run on recovery
  },
);`;

  protected readonly clearQueue = `// user discards the draft: drop anything still waiting to send
this.saveNote.clearQueue();`;

  protected readonly matcher = `readonly createPost = mutationResource(
  (post: Post) => ({ url: '/api/posts', method: 'POST', body: post }),
  {
    invalidates: ['/api/posts'],
    // custom keys that don't follow the default shape:
    invalidateMatcher: (urlPrefix) => (key) => key.includes(urlPrefix),
  },
);`;

  protected readonly upload = `readonly upload = mutationResource<UploadResult, UploadResult, FormData>(
  (form) => ({ url: '/api/upload', method: 'POST', body: form, reportProgress: true }),
);

// trigger it:
const form = new FormData();
form.append('file', file);
this.upload.mutate(form);

// a percentage for the bar:
readonly pct = computed(() => {
  const p = this.upload.progress();
  return p?.total ? Math.round((p.loaded / p.total) * 100) : null;
});`;
}
