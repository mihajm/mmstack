import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-infinite-query',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="infiniteQueryResource"
      pkg="@mmstack/resource"
      lead="Pagination that accumulates. It fetches one page at a time, keeps the pages you have already loaded, and appends the next one on request. Cursor or offset, both fit."
    >
      <p>
        A "load more" list or an infinite scroll feed is a query that grows.
        You don't want to refetch the whole thing each time; you want to keep
        pages one through three and fetch page four onto the end.
        <code>infiniteQueryResource</code> is that: a query whose result is a
        list of pages, with a method to fetch the next one.
      </p>
      <p>
        Every page request inherits the full
        <a mmLink="/docs/resource/query"><code>queryResource</code></a> feature
        set, so per-page caching, retries, and circuit breakers all work the
        same way.
      </p>

      <docs-section title="Setting it up" id="setup">
        <p>
          Two things drive it. The request function receives a
          <code>pageParam</code> and returns the request for that page.
          <code>getNextPageParam</code> looks at the last page (and all pages so
          far) and returns the param for the next one, or
          <code>null</code> when there are no more. That is where cursor and
          offset pagination diverge, and both fit the same signature.
        </p>
        <docs-code [code]="setup" lang="ts" />
        <p>
          Here <code>initialPageParam: 0</code> fetches page zero first, and
          <code>getNextPageParam</code> returns the count of pages loaded as the
          next offset until a short page signals the end. For a cursor API you
          would return <code>last.nextCursor ?? null</code> instead.
        </p>
      </docs-section>

      <docs-section title="Rendering the pages" id="render">
        <p>
          <code>pages()</code> is a signal holding the array of loaded pages.
          Loop the pages, then the items inside each. The button reads
          <code>hasNextPage()</code> to disable itself when exhausted and
          <code>isFetchingNextPage()</code> to show a spinner while a page is on
          the way.
        </p>
        <docs-code [code]="template" lang="html" />
        <p>
          If you would rather render one flat list, flatten the pages in a
          computed. Pairing that with <code>keyArray</code> from
          <a mmLink="/docs/primitives">&#64;mmstack/primitives</a> keeps the
          per-item view models stable, so appending page four doesn't rebuild
          the rows from pages one through three.
        </p>
        <docs-code [code]="flatten" lang="ts" />
      </docs-section>

      <docs-section title="Controls" id="controls">
        <p>
          Four methods and two signals cover the surface. Each does the least
          surprising thing.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>pages()</code></td>
              <td>The array of loaded pages, in order.</td>
            </tr>
            <tr>
              <td><code>fetchNextPage()</code></td>
              <td>
                Load the next page onto the end. A no-op while a page is in
                flight or when there are no more pages.
              </td>
            </tr>
            <tr>
              <td><code>hasNextPage()</code></td>
              <td>
                <code>false</code> once <code>getNextPageParam</code> returns
                <code>null</code>. Bind a button's disabled state to it.
              </td>
            </tr>
            <tr>
              <td><code>isFetchingNextPage()</code></td>
              <td><code>true</code> while a next-page request is in flight.</td>
            </tr>
            <tr>
              <td><code>reload()</code></td>
              <td>
                Refetch the current page in place. The result replaces its slot
                rather than appending a duplicate.
              </td>
            </tr>
            <tr>
              <td><code>reset()</code></td>
              <td>
                Drop every page and refetch from
                <code>initialPageParam</code>. Use it when the underlying query
                changes, for example a new filter.
              </td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="Pausing" id="pause">
        <p>
          The request function receives the same context as a query, plus
          <code>pageParam</code>. That means the <code>paused</code> token works
          identically: return it to hold the connection and its pages instead of
          tearing them down. Handy for a feed in a tab that isn't currently
          visible.
        </p>
        <docs-code [code]="pause" lang="ts" />
      </docs-section>

      <docs-section title="Recipe: infinite scroll" id="recipe">
        <p>
          Trigger <code>fetchNextPage()</code> when a sentinel at the bottom of
          the list scrolls into view. An
          <code>IntersectionObserver</code> is the plain way; the guard on
          <code>hasNextPage()</code> keeps it from firing past the end.
        </p>
        <docs-code [code]="scroll" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class InfiniteQueryDoc {
  protected readonly setup = `import { infiniteQueryResource } from '@mmstack/resource';

type PostPage = { items: Post[] };

readonly posts = infiniteQueryResource<PostPage, PostPage, number>(
  ({ pageParam }) => ({ url: '/api/posts', params: { page: pageParam } }),
  {
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.items.length < 20 ? null : all.length, // null = no more pages
    cache: true,
  },
);`;

  protected readonly template = `@for (page of posts.pages(); track $index) {
  @for (post of page.items; track post.id) {
    <p>{{ '{' }}{{ '{' }} post.title {{ '}' }}{{ '}' }}</p>
  }
}
<button (click)="posts.fetchNextPage()" [disabled]="!posts.hasNextPage()">
  @if (posts.isFetchingNextPage()) { Loading… } @else { Load more }
</button>`;

  protected readonly flatten = `import { keyArray } from '@mmstack/primitives';

// one flat list across every page
readonly items = computed(() => this.posts.pages().flatMap((p) => p.items));

// stable per-item view models: appending a page doesn't recreate the earlier rows
readonly rows = keyArray(this.items, (item) => buildRowVm(item), {
  key: (item) => item.id,
});`;

  protected readonly pause = `readonly feed = infiniteQueryResource<PostPage, PostPage, number>(
  ({ pageParam, paused }) =>
    this.active() ? { url: '/api/feed', params: { page: pageParam } } : paused,
  { initialPageParam: 0, getNextPageParam: (last, all) => all.length },
);`;

  protected readonly scroll = `readonly sentinel = viewChild<ElementRef>('sentinel');

constructor() {
  effect((onCleanup) => {
    const el = this.sentinel()?.nativeElement;
    if (!el) return;

    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && this.posts.hasNextPage()) {
        this.posts.fetchNextPage();
      }
    });
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
}`;
}
