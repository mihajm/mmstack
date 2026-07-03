import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-testing',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Testing"
      pkg="@mmstack/resource"
      lead="Test doubles for the parts of a resource that reach for real browser APIs: a deterministic cache, controllable network and visibility sensors, and an in-memory mutation stash. HTTP itself stays on Angular's own testing backend."
    >
      <docs-section title="A deterministic cache" id="cache">
        <p>
          <code>provideMockQueryCache()</code> is a real in-memory cache built
          for specs. It never touches IndexedDB or <code>BroadcastChannel</code>
          and disables the cleanup sweep, so it is safe under fake timers and
          leaves nothing pinned between tests. Because it is a real cache and not
          a stub, cache hits behave as they do in production and you can assert
          against them.
        </p>
        <docs-code [code]="mockCache" lang="ts" />
        <p>
          HTTP responses go through Angular's own
          <code>provideHttpClientTesting()</code> and
          <code>HttpTestingController</code>. A cache miss flows through the
          interceptor chain to the testing backend like any other request, so
          you flush responses the usual way.
        </p>
      </docs-section>

      <docs-section title="Network and visibility" id="sensors">
        <p>
          Resources pause when the network drops or the page hides. To drive
          that in a test, <code>provideMockResourceSensors()</code> swaps the
          real <code>navigator.onLine</code> and
          <code>document.visibilityState</code> for writable signals you control.
          Pass your own to toggle state mid-test, or omit them for a static
          online and visible environment.
        </p>
        <docs-code [code]="mockSensors" lang="ts" />
      </docs-section>

      <docs-section title="Offline mutation persistence" id="persistence">
        <p>
          For mutations that persist across an app close,
          <code>provideMockMutationPersistence()</code> is an in-memory stand-in
          for the IndexedDB stash. Seed it with rows to simulate mutations a
          previous session left behind, then instantiate the
          <code>mutationResource</code> with the matching
          <code>persist.key</code> and assert that they replay.
        </p>
        <docs-code [code]="mockPersistence" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class ResourceTestingDoc {
  protected readonly mockCache = `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideMockQueryCache,
} from '@mmstack/resource';

TestBed.configureTestingModule({
  providers: [
    provideMockQueryCache(), // timer-free, no IndexedDB, no BroadcastChannel
    provideHttpClient(
      withInterceptors([
        createCacheInterceptor(),
        createDedupeRequestsInterceptor(),
      ]),
    ),
  ],
});`;

  protected readonly mockSensors = `import { signal } from '@angular/core';
import { provideMockResourceSensors } from '@mmstack/resource';

const online = signal(true);

TestBed.configureTestingModule({
  providers: [provideMockResourceSensors({ networkStatus: online })],
});

// later, simulate going offline:
online.set(false); // the resource sees the network drop and disables`;

  protected readonly mockPersistence = `import { provideMockMutationPersistence } from '@mmstack/resource';

TestBed.configureTestingModule({
  providers: [
    provideMockMutationPersistence({
      // seed a mutation as if a prior session left it unsettled
      rows: [{ key: 'save-post', raw: { id: 1, title: 'Draft' } }],
    }),
  ],
});`;
}
