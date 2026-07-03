import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-offline',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Offline and reconnection"
      pkg="@mmstack/resource"
      lead="What resources do when the network drops and comes back: stop reads, stop burning retries, refetch on return, and queue writes so they fire when you are online again."
    >
      <p>
        Handling offline by hand is a lot of small, easy-to-miss work. You have
        to detect the drop, stop retrying into a dead network, refetch once you
        are back, and decide what happens to a write the user triggered while
        disconnected. Getting one of those wrong tends to show up as a wasted
        request storm or a lost save.
      </p>
      <p>
        The library does most of this by default. This page explains what
        happens so you can rely on it and tune the parts that are yours to
        decide, mainly whether writes should queue and whether they should
        survive an app close.
      </p>

      <docs-section title="Reads stop when the network drops" id="pause">
        <p>
          When the browser goes offline, a query stops firing.
          <code>disabled()</code> becomes <code>true</code> and
          <code>disabledReason()</code> reports <code>'offline'</code>. While in
          this state nothing burns retry attempts, so a flaky connection does not
          eat through a retry budget it was never going to spend well. The last
          value stays readable the whole time.
        </p>
        <p>
          <code>disabledReason()</code> is the signal to branch your UI on. It is
          one of <code>'offline'</code>, <code>'circuit-open'</code> (the circuit
          breaker tripped after repeated failures), <code>'no-request'</code>
          (the request function returned <code>undefined</code>), or
          <code>null</code> when the resource is enabled. Reading that directly is
          clearer than trying to infer the cause from combined status.
        </p>
        <docs-code [code]="disabledReason" lang="ts" />
      </docs-section>

      <docs-section title="Refetch when you come back" id="refresh">
        <p>
          Data you looked at before going offline is probably stale by the time
          you return. The <code>refresh</code> option can refetch on the events
          that mark a return: <code>onReconnect</code> fires when the browser
          comes back online, and <code>onFocus</code> fires when the tab becomes
          visible again. Both respect disabled and paused state, so they do not
          fire into a still-dead network.
        </p>
        <docs-code [code]="refresh" lang="ts" />
        <p>
          Compose the object form with <code>interval</code> for "poll while the
          tab is visible, and refresh the moment I come back to it". The interval
          keeps the data warm while you are looking at it, and the focus trigger
          catches the gap after you have been away.
        </p>
        <docs-code [code]="pollVisible" lang="ts" />
      </docs-section>

      <docs-section title="Writes that survive going offline" id="queue">
        <p>
          A read can just wait. A write the user already committed to, a posted
          comment, a saved note, should not be dropped because the network
          happened to be down at that instant. Pass <code>queue: true</code> to a
          <code>mutationResource</code> and mutations serialize into a FIFO that
          runs one at a time, and that queue persists across disabled states.
        </p>
        <docs-code [code]="queue" lang="ts" />
        <p>
          So a POST triggered while offline sits in the queue and fires when the
          resource recovers. That resilience comes with a UX caveat worth stating
          plainly: a queued mutation can fire long after the user triggered it. If
          that timing would be surprising in your interface (a "send" that lands
          minutes later), do not reach for <code>queue</code> without designing
          for the delay.
        </p>
      </docs-section>

      <docs-section title="Writes that survive an app close" id="persist">
        <p>
          The queue lives in memory, so a queued mutation is lost if the tab
          closes before it fires. Add <code>persist: {{ '{' }} key: '...' {{ '}' }}</code>
          alongside <code>queue: true</code> and accepted-but-unsettled mutations
          are stored in IndexedDB. They replay when a
          <code>mutationResource</code> with the same <code>persist.key</code> is
          next instantiated while online, or when the network is regained.
        </p>
        <docs-code [code]="persist" lang="ts" />
        <p>
          The <code>key</code> is the stable identity of this kind of mutation
          across sessions, which is how a fresh instance knows which stored rows
          are its to replay. Replay runs the normal lifecycle, so
          <code>onMutate</code>, <code>onSuccess</code>, and <code>onError</code>
          all fire with their closures intact (which is why replay activates at
          resource instantiation, not from a serialized callback).
          <code>onError</code> receives <code>{{ '{' }} replayed: true {{ '}' }}</code>
          so your reconciliation policy can tell a replayed failure apart, and
          <code>invalidates</code> fires for replayed successes too, so server
          truth wins after a replay. Ordering is per-key FIFO for queued
          resources.
        </p>
        <p>
          Because replay runs your optimistic hooks, this pairs directly with
          <a mmLink="/docs/resource/optimistic">optimistic updates</a>: the same
          rollback and reconcile logic applies whether the mutation ran this
          session or replayed from disk after a restart. For a "3 changes waiting
          to sync" surface and a manual "sync now" button, read the pending
          mutations with <code>injectPendingMutations()</code>.
        </p>
      </docs-section>

      <docs-section title="Streams reconnect on their own" id="streams">
        <p>
          A <a mmLink="/docs/resource/streaming">streamResource</a> handles the
          outage itself. Connection failures retry with exponential backoff,
          persistent by default, and it is offline-aware in the same way as
          queries: while offline nothing burns attempts, and regaining the
          network reconnects immediately on a fresh ladder. The last value stays
          readable through the whole drop, and only genuinely exhausted retries
          surface as an error.
        </p>
        <docs-code [code]="stream" lang="ts" />
        <p>
          Tune it with <code>reconnect: 0</code> for a single-shot connection, or
          <code>{{ '{' }} max, backoff {{ '}' }}</code> to cap the attempts and
          set the base delay.
        </p>
      </docs-section>

      <docs-section title="Testing offline behavior" id="testing">
        <p>
          You do not want a test to depend on the real
          <code>navigator.onLine</code>. Provide controllable sensors with
          <code>provideMockResourceSensors()</code> and pass a writable signal for
          <code>networkStatus</code>. Flip it in the test to simulate a drop and a
          return.
        </p>
        <docs-code [code]="testing" lang="ts" />
        <p>
          Setting the signal to <code>false</code> makes the resource see the
          network drop, so <code>disabledReason()</code> becomes
          <code>'offline'</code>; setting it back to <code>true</code> is the
          reconnect, which triggers the same refetch and queue-flush behavior as
          a real return.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class OfflineDoc {
  protected readonly disabledReason = `@switch (posts.disabledReason()) {
  @case ('offline') {
    <p>You are offline. Showing the last loaded posts.</p>
  }
  @case ('circuit-open') {
    <p>The posts service is having trouble. Retrying soon.</p>
  }
  @default {
    <ul>
      @for (p of posts.value(); track p.id) {
        <li>{{ '{{' }} p.title {{ '}}' }}</li>
      }
    </ul>
  }
}`;

  protected readonly refresh = `queryResource(() => ({ url: '/api/notifications' }), {
  refresh: { onFocus: true, onReconnect: true },
});`;

  protected readonly pollVisible = `queryResource(() => ({ url: '/api/notifications' }), {
  refresh: { interval: 60_000, onFocus: true }, // poll while visible, refresh on return
});`;

  protected readonly queue = `const saveNote = mutationResource(
  (note: Note) => ({ url: '/api/notes', method: 'POST', body: note }),
  { queue: true }, // serialized, and survives the offline window
);

// triggered while offline -> waits in the queue -> fires when back online
saveNote.mutate(note);`;

  protected readonly persist = `const saveNote = mutationResource(
  (note: Note) => ({ url: '/api/notes', method: 'POST', body: note }),
  {
    queue: true,
    persist: {
      key: 'save-note', // stable identity of this mutation KIND across sessions
      // ttl (default 7 days); serialize/deserialize for non-cloneable payloads;
      // keepOnError to retry transient failures on the next replay
    },
    invalidates: ['/api/notes'], // fires for replayed successes too
  },
);`;

  protected readonly stream = `const chat = streamResource<ChatMessage>(() => '/api/chat/stream', {
  transport: sse(),
  // reconnect: persistent by default (1s base, 30s cap)
  // reconnect: 0,                     // single-shot
  // reconnect: { max: 5, backoff: 2_000 },
});`;

  protected readonly testing = `import { signal } from '@angular/core';
import { provideMockResourceSensors } from '@mmstack/resource';

const online = signal(true);

TestBed.configureTestingModule({
  providers: [provideMockResourceSensors({ networkStatus: online })],
});

online.set(false); // the resource sees the drop and disables
// ...assert disabledReason() === 'offline', queued mutations wait...
online.set(true); // the reconnect: refetch + queue flush`;
}
