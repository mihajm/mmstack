import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-resource-streaming',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="streamResource"
      pkg="@mmstack/resource"
      lead="A live connection with the same signal surface as a query. Server-Sent Events or WebSocket, with reconnection, offline handling, and status built in. value() tracks the latest message."
    >
      <p>
        Live prices, a chat feed, presence, a job's progress: data that pushes
        rather than being pulled. <code>streamResource</code> wraps an SSE or
        WebSocket connection so it looks like every other resource. You read
        <code>value()</code> for the latest message and <code>status()</code>
        for readiness, and it handles the parts of a long-lived connection you'd
        otherwise write yourself, mainly reconnection and staying quiet while
        offline.
      </p>
      <p>
        Because it shares the resource surface, a stream also participates in
        <a mmLink="/docs/primitives/transitions">transition scopes</a> and
        suspense boundaries and works inside <code>latest()</code>, right
        alongside your queries.
      </p>

      <docs-section title="A first stream" id="first">
        <p>
          Give it a request function (a URL string is fine) and pick a
          transport. <code>sse()</code> for Server-Sent Events,
          <code>websocket()</code> for a socket, or your own
          <code>StreamTransport</code>. The URL is reactive, same as a query, so
          changing <code>symbol()</code> tears the old connection down and opens
          a new one.
        </p>
        <docs-code [code]="stream" lang="ts" />
        <p>
          <code>value()</code> holds the most recent message and
          <code>connected()</code> is a live-connection indicator, the little
          dot in the corner. Note that those two are separate on purpose, which
          the status rules below explain.
        </p>
      </docs-section>

      <docs-section
        title="Status and connection are different signals"
        id="status"
      >
        <p>
          <code>status()</code> stays <code>'loading'</code> until the first
          message arrives, because a connection with no data yet honestly isn't
          ready to render. Once a message lands it flips to
          <code>'resolved'</code> and <code>value()</code> tracks every message
          after that.
        </p>
        <p>
          <code>connected()</code> is the transport's own state, independent of
          whether data has arrived. Use <code>status()</code> to decide
          placeholder versus content, and <code>connected()</code> to show a
          live or reconnecting badge. A stream can be connected but still
          <code>'loading'</code> (open, no message yet), or disconnected while
          <code>'resolved'</code> (dropped, holding the last value).
        </p>
      </docs-section>

      <docs-section title="Reconnection and offline" id="reconnect">
        <p>
          A live connection's job is to stay alive, so drops reconnect with
          exponential backoff by default (1s base, 30s cap,
          <em>persistent</em>). Through the outage the last value stays
          readable, and only genuinely exhausted retries surface as
          <code>status: 'error'</code>. <code>reload()</code> starts a fresh
          attempt budget.
        </p>
        <docs-code [code]="reconnect" lang="ts" />
        <p>
          It is offline-aware too: while the browser is offline nothing burns
          attempts, and regaining the network reconnects immediately on a fresh
          ladder. If you want a single-shot connection instead of a persistent
          one, pass <code>reconnect: 0</code>.
        </p>
      </docs-section>

      <docs-section title="Disabling and stopping" id="control">
        <p>
          Two levers, and they mean different things. Return
          <code>undefined</code> from the request function to disconnect (<code
            >status: 'idle'</code
          >), the same disable pattern as a query.
          <code>abort()</code> disconnects and <em>stays</em> disconnected,
          keeping the current value (<code>status: 'local'</code>) until a
          <code>reload()</code> or a source change brings it back. That is what
          <code>scope.abortPending()</code> reaches, so a stream cancels cleanly
          with its transition scope.
        </p>
        <p>
          Streams never connect on the server. A stream never settles, so
          connecting during SSR would wedge serialization. They are client-only
          by design, and there is nothing to configure for that.
        </p>
      </docs-section>

      <docs-section title="Pausing" id="pause">
        <p>
          A socket kept open for a subtree nobody is looking at is wasted
          network and wasted server fan-out. The <code>pause</code> option
          closes the live connection while a condition holds and reconnects the
          moment it lifts, on a fresh backoff ladder. The current value and
          status stay put, so nothing flickers on resume. It takes the same
          forms as the query option: <code>true</code> follows the surrounding
          Activity boundary, a predicate or
          <code>Signal&lt;boolean&gt;</code> is read directly.
        </p>
        <docs-code [code]="pause" lang="ts" />
        <p>
          While paused, <code>connected()</code> is <code>false</code> and a
          <code>send()</code> behaves exactly as it does while disconnected.
        </p>
      </docs-section>

      <docs-section title="Sending messages" id="send">
        <p>
          A WebSocket goes both ways, so <code>websocket()</code> is a
          bidirectional transport and the resource it produces has a
          <code>send()</code> method. Server-Sent Events are read-only, and so
          is the resource you get from <code>sse()</code>; the return type
          follows the transport. Because the socket behind a reconnecting stream
          changes over time, you never hold it yourself:
          <code>send()</code> always writes to whichever connection is live.
        </p>
        <docs-code [code]="send" lang="ts" />
        <p>
          With no open connection (connecting, offline, paused, aborted),
          <code>send()</code> drops the message and returns <code>false</code>.
          Opt into <code>outbox: true</code> to queue instead. A queued message
          is addressed to a connection, not to the resource: it flushes in order
          on the next open of the same source, a source change,
          <code>reload()</code>, <code>abort()</code> or
          <code>destroy()</code> discards it, and once retries are exhausted
          <code>send()</code> returns <code>false</code> rather than queueing
          into a connection that will never come. That is a deliberate opt-in,
          because after a long reconnect wait the whole backlog reaches the
          server at once. Outgoing messages default to
          <code>JSON.stringify</code>; pass <code>serialize</code> for binary
          frames or another wire format.
        </p>
      </docs-section>

      <docs-section title="Parsing and custom transports" id="transport">
        <p>
          Messages default to <code>JSON.parse</code>. Both built-in transports
          take a <code>deserialize</code> function; <code>sse()</code> also
          takes an <code>event</code> name and <code>websocket()</code> takes
          <code>protocols</code>.
        </p>
        <docs-code [code]="deserialize" lang="ts" />
        <p>
          The <code>transport</code> option is the extension point. A custom
          <code>StreamTransport</code> maps any connection-shaped thing (a
          shared STOMP client's topic, a worker port) onto <code>emit</code>,
          <code>open</code>, and <code>fail</code>, and the reconnect and status
          machinery comes with it. Return a connection with a
          <code>send</code> method (a <code>BidiStreamTransport</code>) and the
          resource gains <code>send()</code> too. If a consumer wants events
          rather than the latest-value shape, bridge with
          <code>toObservable(res.value)</code>.
        </p>
      </docs-section>

      <docs-section title="Recipe: live price ticker" id="recipe">
        <p>
          Register the stream as an <code>indicator</code> so a surrounding
          suspense boundary shows the held value with a busy state rather than a
          placeholder, and read <code>connected()</code> for a reconnecting
          hint.
        </p>
        <docs-code [code]="recipe" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class StreamingDoc {
  protected readonly stream = `import { streamResource, sse, websocket } from '@mmstack/resource';

readonly prices = streamResource<PriceTick>(
  () => \`/api/prices/\${this.symbol()}/stream\`,
  {
    transport: sse(), // or websocket(), or your own StreamTransport
  },
);

// prices.value()     -> the latest message
// prices.connected() -> live-connection indicator`;

  protected readonly reconnect = `readonly chat = streamResource<ChatMessage>(() => '/api/chat/stream', {
  transport: sse(),
  // reconnect: persistent by default; tune or disable it
  // reconnect: { max: 5, backoff: 2_000 },
  // reconnect: 0, // single-shot
});`;

  protected readonly pause = `readonly prices = streamResource<PriceTick>(() => '/api/prices/stream', {
  transport: sse(),
  pause: true, // closed while the Activity boundary is paused
  // pause: this.tabHidden, // or any Signal<boolean> / predicate
});`;

  protected readonly send = `readonly chat = streamResource<ChatEvent, ChatCommand>(
  () => '/api/chat/socket',
  {
    transport: websocket(), // bidirectional, so the ref has send()
    outbox: true, // queue while reconnecting instead of dropping
  },
);

sendMessage(text: string) {
  const delivered = this.chat.send({ type: 'message', text });
  // false only without outbox, when nothing was there to hand it to
}

// readonly feed = streamResource<Tick>(() => url, { transport: sse() });
// feed.send(...) does not exist: sse() is a read-only transport`;

  protected readonly deserialize = `streamResource<PriceTick>(() => '/api/prices/stream', {
  transport: sse({
    event: 'tick', // named SSE event
    deserialize: (raw) => JSON.parse(raw) as PriceTick,
  }),
});`;

  protected readonly recipe = `readonly prices = streamResource<PriceTick>(
  () => \`/api/prices/\${this.symbol()}/stream\`,
  {
    transport: sse(),
    register: 'indicator', // hold + busy state inside a suspense boundary
  },
);

readonly live = computed(() => this.prices.connected());`;
}
