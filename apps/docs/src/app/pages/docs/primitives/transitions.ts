import { Component } from '@angular/core';
import {
  AsyncTransactionDemo,
  ComposedSaveDemo,
  DeferredValueDemo,
  ErroredDemo,
  FailedLoadDemo,
  LatestDemo,
  OutcomeDemo,
  RevealDemo,
  TransitionTabsDemo,
} from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-transitions',
  imports: [
    DocPage,
    DocSection,
    CodeExample,
    DemoBox,
    TransitionTabsDemo,
    DeferredValueDemo,
    LatestDemo,
    ErroredDemo,
    FailedLoadDemo,
    RevealDemo,
    AsyncTransactionDemo,
    ComposedSaveDemo,
    OutcomeDemo,
    Link,
  ],
  template: `
    <docs-page
      title="Transitions and suspense"
      pkg="@mmstack/primitives"
      lead="Tools for async UI: hold the current view while the next one loads, keep the last value during a reload, and gate rendering on readiness."
    >
      <docs-section title="The problem" id="problem">
        <p>
          When a value drives an <code>&#64;switch</code> or an
          <code>&#64;if</code>, changing it unmounts the old branch right away.
          If the new branch loads data, the user sees a spinner between the two
          states. Switch tabs three times and you get three flashes.
        </p>
        <p>
          A transition fixes the timing. The old view stays on screen until the
          new one has what it needs, then both swap in a single frame.
        </p>
      </docs-section>

      <docs-section title="What do you need?" id="needs">
        <ul>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="suspense"
              >Keep content visible while the next data loads</a
            >
          </li>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="failures"
              >Handle a failed load</a
            >
          </li>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="transactions"
              >Coordinate a save you might take back</a
            >
          </li>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="reveal"
              >Reveal sibling boundaries in order</a
            >
          </li>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="guesses"
              >Show a guess that reverts on its own</a
            >
          </li>
          <li>
            <a mmLink="/docs/primitives/transitions" fragment="together"
              >See them working together</a
            >
          </li>
        </ul>
      </docs-section>

      <docs-section title="Transition scopes" id="scopes">
        <p>
          A scope tracks the resources created under it and reports whether any
          are still loading through a <code>pending</code> signal. Resources
          join the nearest scope when you register them.
          <code>provideTransitionScope()</code> opens a fresh scope at a
          component boundary, and <code>registerResource()</code> adds a
          resource to it.
        </p>
        <docs-code [code]="scopeEx" lang="ts" />
        <p>
          Resources from
          <a mmLink="/docs/resource">&#64;mmstack/resource</a> and Angular's own
          <code>resource()</code> both work. The transition primitives below
          read a scope to know when to swap.
        </p>
      </docs-section>

      <docs-section title="*mmTransition" id="mm-transition">
        <p>
          <code>*mmTransition</code> holds and swaps around any value change.
          The old view keeps its value and stays visible while the new one
          mounts hidden in its own scope. Once that scope settles, they swap.
          The demo runs the same tab panel twice: a plain switch on the left, a
          transition on the right.
        </p>
        <docs-demo title="Flash versus hold">
          @defer (on viewport) {
            <demo-transition-tabs />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="transitionEx" label="template" lang="html" />
        <p>
          The value is required. First render shows immediately since there is
          nothing to hold. Set <code>mmTransitionImmediate</code> to skip
          holding, and <code>mmTransitionViewTransition</code> to animate the
          swap with the View Transitions API where the browser supports it.
        </p>
      </docs-section>

      <docs-section title="mm-suspense" id="suspense">
        <p>
          <code>&lt;mm-suspense&gt;</code> is the readiness gate for a single
          branch. It shows a placeholder until a first value lands, then keeps
          the real content mounted through later reloads and marks it busy
          instead of falling back. Where <code>*mmTransition</code> decides when
          to swap between two views, suspense decides placeholder versus content
          inside one. They compose.
        </p>
        <docs-code [code]="suspenseEx" label="template" lang="html" />
        <p>
          <code>&lt;mm-suspense&gt;</code> provides its own scope, so dropping
          it anywhere just works. Use <code>&lt;mm-unscoped-suspense&gt;</code>
          instead when the resources to coordinate are registered above the
          boundary and you want it to read that outer scope rather than open a
          fresh one.
        </p>
      </docs-section>

      <docs-section title="When a load fails" id="failures">
        <p>
          A failure can land in two very different places. If a load fails and
          there is nothing to show yet, the boundary swaps to its
          <code>[error]</code> slot, which replaces both placeholder and
          content. If there is something on screen already, say rows held with
          <code>keepPrevious</code> while a reload ran, the failure never
          replaces them. The rows stay, the optional <code>[failed]</code> slot
          renders beside them and the host gets a
          <code>data-failed</code> attribute.
        </p>
        <docs-code [code]="failuresEx" label="template" lang="html" />
        <p>
          The scope reports the two separately. <code>failed()</code> is true
          when something failed with nothing to show.
          <code>errored()</code> lists every member failing right now, content
          or not, as <code>{{ '{' }} member, failure {{ '}' }}</code> entries
          with a <code>displayName</code> and a <code>message</code>. Both sides
          below use the same template; only when the failure happens differs.
        </p>
        <docs-demo title="A failed first load and a failed reload">
          @defer (on viewport) {
            <demo-failed-load />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          <code>mmRetryFailed</code> calls <code>scope.retryAll()</code> on
          click. <code>*mmSuspenseError</code> renders its template while
          <code>errored()</code> is not empty and gives it the entries as
          <code>$implicit</code>, plus <code>retry</code>,
          <code>dismiss(entry)</code> and <code>dismissAll()</code>.
        </p>
        <p>
          A retry is a round. <code>retryAll()</code> re-runs every member that
          can retry and isn't already in flight, failed or not. The round is the
          unit: each capable member runs at most once in it, so a healthy query
          in the same boundary reloads along with the failed one rather than
          being skipped. <code>scope.retry(id)</code> runs a round for one
          member. Each round returns
          <code>{{ '{' }} dispatched, settled() {{ '}' }}</code
          >. A second click while the first round is still loading finds those
          members in flight and dispatches nothing, so a double retry can't
          happen. Resource registrations retry through their
          <code>reload()</code>. Members without a retry (work you enroll
          yourself, a failed save) can be dismissed instead, which hides the
          failure until that member fails again.
        </p>
        <p>
          Two scope options round this off.
          <code
            >provideTransitionScope({{ '{' }} deadline: {{ '{' }} ms: 10_000
            {{ '}' }} {{ '}' }})</code
          >
          declares a blocking member failed if it hasn't settled in time, so a
          request that never answers can't leave a placeholder up forever. And
          by default (<code>'pending-first'</code>) the boundary's error state
          waits until its blocking loads settle, so two failures from one
          incident show up together and one retry covers both. Background
          activity (indicator registrations, a reload behind held content)
          doesn't hold it back, and <code>errored()</code> can already list
          failures in the meantime. <code>precedence: 'error-first'</code>
          shows the error state as soon as a blocking member fails.
        </p>
      </docs-section>

      <docs-section title="Revealing siblings in order" id="reveal">
        <p>
          Sibling boundaries show their content whenever their own data lands,
          so a page can fill in bottom-up, or a feed can appear above the
          profile it belongs to. <code>&lt;mm-reveal&gt;</code> decides when
          each boundary directly inside it may show its content.
        </p>
        <docs-code [code]="revealEx" label="template" lang="html" />
        <p>
          With <code>order="forwards"</code>, the default, a boundary shows once
          it is ready and every boundary before it has shown.
          <code>"backwards"</code> is the mirror, and
          <code>"together"</code> waits for all of them. A boundary that is
          ready but held back keeps its placeholder; with
          <code>collapsed</code> it renders nothing, so only the next one in
          line shows a placeholder. The feed below loads fastest and still waits
          for the profile.
        </p>
        <docs-demo title="Three boundaries, one order">
          @defer (on viewport) {
            <demo-reveal />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          A failure follows <code>onError</code>. With
          <code>'settled'</code> (the default) a failed boundary shows its error
          and the rest carry on. With <code>'blocks'</code> it shows its error
          and holds the boundaries after it until a retry succeeds, for when the
          order really means "this needs that first". Once a boundary has been
          released it no longer waits for the reveal; if it suspends again, its
          own suspense behaviour still applies. Only direct child boundaries
          take part, in the order they were created, and the reveal only
          schedules display: held content is created and loads as usual.
        </p>
      </docs-section>

      <docs-section title="Render errors and @boundary" id="boundary">
        <p>
          Everything above is about loads, and a failed load never throws into
          the template: a <code>&#64;mmstack/resource</code> query hands its
          error back as a value and <code>value()</code> keeps returning what it
          had. Angular's
          <code
            >&#64;boundary {{ '{' }} … {{ '}' }} &#64;error {{ '{' }} …
            {{ '}' }}</code
          >
          block is for the other kind, a template that throws while it renders.
          The two don't overlap, so they compose, with one rule: put
          <code>&#64;boundary</code> inside the branch it guards (inside the
          <code>*mmTransition</code> template, inside the routed component),
          never around <code>*mmTransition</code> or the transition outlet. On a
          throw it removes its whole block, and around a swap that block holds
          both the outgoing and the incoming view.
        </p>
        <p>
          Render boundaries don't catch everything. Errors in event listeners,
          root effects, <code>afterRender</code> callbacks, promises and
          <code>&#64;defer</code> loads go straight to your
          <code>ErrorHandler</code>, and so does a view effect that runs while
          its view is only being traversed. Projected content belongs to the
          template that declared it, so a boundary around
          <code>&lt;ng-content&gt;</code> doesn't cover it either.
        </p>
      </docs-section>

      <docs-section title="Keeping state through a render error" id="errored">
        <p>
          Angular's <code>&#64;boundary</code> catches a throw while its block
          renders, removes the block and builds it again on
          <code>$reset()</code>. For a stateless widget that's fine. For a form
          the user is halfway through, it throws away what they typed.
          <code>*mmErrored</code> catches the same throws but keeps the content:
          the view is detached and hidden, its components stay alive, and the
          fallback renders in its place with the error and a <code>retry</code>.
        </p>
        <docs-code [code]="erroredEx" label="template" lang="html" />
        <p>
          Type a note on both sides, break the price, then fix it. The left side
          comes back empty, the right side comes back as you left it.
        </p>
        <docs-demo title="&#64;boundary versus *mmErrored">
          @defer (on viewport) {
            <demo-errored />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          <code>retry()</code> renders the kept view again with the same
          instances. A <code>computed</code> that cached the throw throws again
          until something it reads changes, so retrying before the fix just
          lands on the fallback again. When the kept state is itself what
          throws, <code>retry({{ '{' }} rebuild: true {{ '}' }})</code> destroys
          the content and builds it fresh, the way <code>&#64;boundary</code>
          does. A throw while the content is first being built leaves nothing to
          keep, so that case always rebuilds.
        </p>
        <p>
          The content is hidden rather than left on screen, because the DOM
          after a throw is whatever the failed pass wrote before it stopped.
          Each catch is reported to your <code>ErrorHandler</code> once, and
          inside a transition scope the fault shows up in the scope's
          <code>errored()</code> list without blanking the boundary. The
          not-caught list above applies here too, and init hooks that already
          ran don't run again on retry.
        </p>
      </docs-section>

      <docs-section title="Imperative transitions" id="start-transition">
        <p>
          <code>injectStartTransition()</code> runs an update as a transition
          from code, for cases where there is no structural directive to hang it
          on.
        </p>
        <docs-code [code]="startEx" lang="ts" />
      </docs-section>

      <docs-section title="Transactions" id="transactions">
        <p>
          A transaction generalizes <code>startTransition</code> to a multi-step
          update you might want to take back.
          <code>injectStartTransaction()</code> returns a
          <code>startTransaction(fn)</code> bound to the nearest scope. It
          freezes the scope's display at the pre-transaction values, then runs
          <code>fn</code>. The writes land on live state right away, so derived
          values and connector requests see them and refetch, but the display
          stays held. On settle it releases the hold and keeps the writes; call
          <code>abort()</code> to roll the writes back and release the hold
          without ever showing the intermediate state.
        </p>
        <docs-code [code]="transactionEx2" lang="ts" />
        <p>
          Rollback covers the writes the transaction recorded, and nothing else
          is intercepted. A store records its root the first time it is written
          inside a transaction, and <code>derived</code>,
          <code>keepPrevious</code> and the pausable signals record the source
          they write to. A plain <code>signal</code> of your own needs
          <code>transactional(sig)</code> (or
          <code>activeTransaction()?.record(sig)</code> before the write).
          Anything written some other way stays put after <code>abort()</code>.
        </p>
        <p>
          Two transactions can overlap. Aborting one only undoes its writes that
          are still current: if a later transaction wrote the same signal in the
          meantime, the later value stays. For a store, the paths only the
          aborted transaction touched go back and the rest keep what is there
          now. The limit is a value someone else calculated from the aborted one
          and stored. Say A writes <code>x</code> and B stores
          <code>twiceX</code> as twice that; when A aborts,
          <code>x</code> reverts and the stored <code>twiceX</code> stays as it
          is. A <code>computed(() =&gt; 2 * x())</code> has no such problem, it
          just recomputes from the reverted <code>x</code>.
        </p>
        <p>
          The returned handle also carries <code>pending</code> and a
          <code>done</code> promise. With a synchronous body, work has to go in
          flight by the first render after the writes to be part of the
          transaction, so a loader behind a debounce is missed. A load that was
          already running when the transaction began is not adopted.
          <code>tx.retain()</code> keeps the transaction open: it returns a
          release function, and the transaction can't settle until every release
          has been called, so call it in a <code>finally</code>.
        </p>
        <docs-code [code]="retainEx" lang="ts" />
        <p>
          The synchronous form keeps its recorded writes if its injection
          context is destroyed mid-flight; it only releases the hold. For the
          plumbing under it,
          <code>createTransaction()</code> is the bare undo log with no scope
          involved.
        </p>
      </docs-section>

      <docs-section
        title="Transactions across an await"
        id="async-transactions"
      >
        <p>
          Pass an async body and the transaction stays open until three things
          are true: the body's promise has settled, the loads attributed to it
          have finished, and every <code>tx.retain()</code> has been released.
          The catch is the usual one with async functions: code after an
          <code>await</code> runs outside whatever was active when the body
          started. <code>tx.enter(() =&gt; ...)</code> puts it back in for one
          synchronous slice, so writes and loads started there belong to this
          transaction.
        </p>
        <docs-code [code]="asyncTxEx" lang="ts" />
        <p>
          Hit save below and watch the two middle cards. The live state moves at
          once, the screen keeps the old name until the body is done, then both
          values arrive together. Abort, or let the server reject, and the
          recorded writes go back. The bottom row compares a plain
          <code>effect</code> with <code>heldEffect</code>, covered further
          down.
        </p>
        <docs-demo title="Rename, await, enter">
          @defer (on viewport) {
            <demo-async-transaction />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          <code>done</code> never rejects. It resolves with
          <code>{{ '{' }} kind: 'completed' {{ '}' }}</code
          >, <code>{{ '{' }} kind: 'aborted', reason {{ '}' }}</code> or
          <code>{{ '{' }} kind: 'failed', error {{ '}' }}</code
          >. A write after an <code>await</code> that you forget to wrap still
          lands and the display stays held, but an abort won't undo it. A load
          Angular starts later in response to the slice's writes counts by time,
          like any load started while the transaction is open. Once the
          transaction has settled, <code>enter</code> and
          <code>retain</code> throw, though nothing can stop a leftover
          continuation from writing a signal directly. A
          <code>startTransaction</code> called inside a slice joins the outer
          transaction rather than starting its own, so aborting the nested
          handle aborts the shared transaction. And unlike the synchronous form,
          destroying the context mid-await restores the recorded writes and
          settles <code>aborted</code>.
        </p>
        <p>
          Views that mount while a transaction holds (an
          <code>&#64;if</code> that opens halfway through, a tab swapped in
          below the page) start from the pre-transaction values of the signals
          the transaction recorded, so they match the rest of the held page and
          reveal with it. A hold on a scope also holds the scopes created inside
          it. Values the transaction didn't record still show live.
        </p>
      </docs-section>

      <docs-section title="Effects that wait" id="held-effect">
        <p>
          A held display doesn't stop effects. They see every write as it lands,
          which for analytics, a document title or a scroll restore means acting
          on a state the user never saw.
          <code>heldEffect(fn)</code> waits it out: while the nearest scope is
          holding or loading, a change only marks it stale, and when the hold
          ends it runs once with the latest values. In the demo above the plain
          effect logs every step of a save, the held one logs the result.
        </p>
        <docs-code [code]="heldEffectEx" lang="ts" />
        <p>
          It can't tell one change from many, and a hold with no change in it
          runs nothing. Pass <code>scope</code> to watch another scope or
          <code>gate</code> for your own condition. Template bindings are
          Angular's and are not held, so the values a template shows still go
          through <code>*mmTransition</code> or the scope's <code>hold</code>.
        </p>
      </docs-section>

      <docs-section title="Guesses" id="guesses">
        <p>
          A guess is a value shown before its truth is known, and it's gone when
          its transaction settles, however that ends. There are two tiers and no
          default. The live tier, <code>guessable(sig)</code> with
          <code>tx.guess(node, value)</code>, changes the signal in place over a
          truth kept beneath it, so every reader sees the guess; use it for a
          write that almost always succeeds, like a like toggle. The overlay
          tier, <code>optimistic(sig)</code> or
          <code>optimisticStore(base)</code> with <code>tx.overlay(view)</code>,
          is a fork per transaction that only the view's readers see and that is
          thrown away at the end; use it for multi-field edits like a modal
          form.
        </p>
        <docs-code [code]="guessEx" lang="ts" />
        <p>
          The frozen frame is the truth beneath the guess: a
          <code>hold</code> over a guessable shows the guess live and freezes
          only the truth, so a held view never keeps a guess after it reverts. A
          <code>computed</code> over a guessed value doesn't get that for free.
          Held, it freezes what it computed, guess included, so hold the
          guessable itself or read <code>node.truth()</code> inside the
          derivation. A request built from a live guess fires like any other;
          return <code>undefined</code> from the request function while the
          input is provisional if that's not wanted. The full rules are in the
          <a
            href="https://www.npmjs.com/package/@mmstack/primitives#optimistic-writes"
            >primitives README</a
          >, and
          <a mmLink="/docs/resource/optimistic"
            >mutationResource's optimistic option</a
          >
          opens one of these transactions per save.
        </p>
      </docs-section>

      <docs-section
        title="Morphing elements across a swap"
        id="view-transition-name"
      >
        <p>
          When a held swap runs through the View Transitions API
          (<code>mmTransitionViewTransition</code>, or the transition outlet's
          option), the browser can morph an element from the outgoing view into
          its counterpart in the incoming one instead of cross-fading the whole
          boundary. <code>mmViewTransitionName</code> assigns the pairing name
          per element, so a thumbnail in a list can grow into the hero image on
          the detail view.
        </p>
        <docs-code [code]="viewNameEx" label="template" lang="html" />
        <p>
          The name is normalized to a valid CSS ident, and an empty string or
          <code>'none'</code> clears it. The one rule to keep is that a name
          must be unique among elements visible at capture time, so derive it
          from an id for anything that repeats.
        </p>
      </docs-section>

      <docs-section title="Value-level tools" id="values">
        <p>
          <code>latest</code> builds a derivation over resources with
          <code>use</code>. While a dependency reloads it returns the previous
          result instead of undefined, so downstream reads stay stable. Switch
          users below: the left panel reads the resource directly and blinks to
          empty, the right one holds the last value through the reload.
        </p>
        <docs-demo title="Keep the last value during a reload">
          @defer (on viewport) {
            <demo-latest />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="latestEx" lang="ts" />
        <p>
          Under <code>latest</code> sits <code>keepPrevious</code>, the base
          stale-while-revalidate primitive. It wraps a single signal so it holds
          its last defined value whenever the source goes
          <code>undefined</code>, which is exactly what a resource does
          mid-reload. Reach for it directly when you want to hold one value
          rather than derive over several, and for a structure rather than a
          value there is <code>holdUntilReady(target, ready)</code>: it keeps
          yielding the previous target until the <code>ready()</code> predicate
          flips, so you can mount an incoming subtree off to the side and swap
          only once it has settled. Both are also useful for holding native
          resource snapshots.
        </p>
        <docs-code [code]="keepPreviousEx" lang="ts" />
        <p>
          <code>deferredValue</code> lets a signal lag behind its source so an
          expensive render can be deprioritized, similar in spirit to React's
          <code>useDeferredValue</code>. Type quickly in the filter below: the
          input stays on the live value while the list catches up from the
          deferred one, and <code>deferred.pending()</code> reports the gap. The
          list rows here are deliberately slowed to stand in for an expensive
          render, which is where deferring actually pays off.
        </p>
        <docs-demo title="Deferred filtering">
          @defer (on viewport) {
            <demo-deferred-value />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <docs-code [code]="deferredEx" lang="ts" />
      </docs-section>

      <docs-section title="Async state as a value" id="sentinels">
        <p>
          A resource's <code>outcome()</code> reads its whole state as one
          value: the data, <code>undefined</code> when nothing was requested, or
          a sentinel. <code>loading</code> means there is nothing to show yet,
          <code>error</code> means the load failed, and <code>DONE</code> means
          it settled with nothing to return (a mutation whose result is
          <code>undefined</code>). Narrow them with <code>isLoading</code>,
          <code>isError</code> and <code>isDone</code>, or supply a fallback
          with <code>ifLoading</code> / <code>ifError</code>.
        </p>
        <docs-code [code]="outcomeValueEx" lang="ts" />
        <p>
          For several independent resources, <code>joined</code> reads all of
          them and hands back a tagged <code>Result</code>: <code>value</code>,
          <code>pending</code> or <code>error</code>. It never throws, so it
          switches nicely in a template. <code>settle(outcome)</code> turns a
          single outcome into the same shape. A sentinel that reaches a template
          binding by accident renders as <code>[mmstack loading]</code> (or
          <code>error</code>, <code>done</code>) and is reported once;
          <code>provideStrictSentinels()</code> at the root makes that a thrown
          error instead, for as long as the application lives.
        </p>
        <docs-code [code]="joinedEx" lang="ts" />
      </docs-section>

      <docs-section title="Reading a resource in a template" id="outcome">
        <p>
          A boundary knows about the resources registered inside it. A resource
          created above the boundary and only read inside it is invisible to it,
          so the boundary renders content around an empty value.
          <code>*mmOutcome</code> makes the read count: it takes the resource,
          renders its template while there is a value, and while the resource is
          loading or failed it joins the nearest boundary as a member of its
          own.
        </p>
        <docs-code [code]="outcomeEx" label="template" lang="html" />
        <docs-demo title="A read that holds the boundary">
          @defer (on viewport) {
            <demo-outcome />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          The optional <code>loading</code> and <code>error</code> templates
          render in place of the content, and the error one gets a
          <code>retry</code> that reloads the resource. If the same resource is
          also registered in that boundary it still counts once. A
          <code>latest</code> works here too. The rule of thumb: reach for
          <code>latest</code> where you'd write a <code>computed</code> over
          resources, and for <code>*mmOutcome</code> where you'd read one in a
          template.
        </p>
      </docs-section>

      <docs-section title="On the router" id="router">
        <p>
          The same idea drives navigation in
          <a mmLink="/docs/router-core">&#64;mmstack/router-core</a>:
          <code>mm-transition-outlet</code> holds the current route until the
          next one settles, then swaps.
        </p>
      </docs-section>
      <docs-section title="Putting it together" id="together">
        <p>
          One boundary, two queries, two writes. The name gets a guess, the
          address save fails the first time, and the orders refresh is
          debounced. Each piece covers a gap the others leave.
        </p>
        <docs-code [code]="composedEx" lang="ts" />
        <docs-demo title="A save that touches the whole page">
          @defer (on viewport) {
            <demo-composed-save />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
        <p>
          The guess makes the click feel instant without lying for long. The
          hold keeps the address and the list from disagreeing while the refresh
          runs, and <code>retain</code> keeps that hold up past a debounce. The
          registered mutation keeps "address failed" next to rows that are still
          correct, until the next attempt starts.
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
export class TransitionsDoc {
  protected readonly scopeEx = `import { resource } from '@angular/core';
import { provideTransitionScope, registerResource } from '@mmstack/primitives';

@Component({
  providers: [provideTransitionScope()], // a fresh scope for this subtree
})
class Panel {
  readonly data = registerResource(
    resource({ params: () => this.id(), loader: ({ params }) => load(params) }),
  );
}`;

  protected readonly transitionEx = `<ng-container *mmTransition="selectedTab(); let tab">
  <app-panel [tab]="tab" />
</ng-container>`;

  protected readonly suspenseEx = `<mm-suspense>
  <app-panel />
  <p placeholder>Loading…</p>
</mm-suspense>`;

  protected readonly startEx = `import { injectStartTransition } from '@mmstack/primitives';

const startTransition = injectStartTransition();

startTransition(() => {
  this.selectedTab.set('activity'); // held and swapped, not flashed
});`;

  protected readonly latestEx = `import { latest, use } from '@mmstack/primitives';

const summary = latest(() => {
  const u = use(userResource); // short-circuits until it has a value
  const o = use(ordersResource);
  return u.name + ': ' + o.length + ' orders';
});`;

  protected readonly transactionEx2 = `import { Component, signal } from '@angular/core';
import {
  injectStartTransaction,
  injectTransitionScope,
  provideTransitionScope,
  transactional,
} from '@mmstack/primitives';

@Component({
  providers: [provideTransitionScope()],
  // the template reads the held signals, never range() / groupBy() directly
  template: \`<h2>{{ shownRange() }} by {{ shownGroupBy() }}</h2>\`,
})
class Report {
  private readonly startTransaction = injectStartTransaction();
  private readonly scope = injectTransitionScope();

  // transactional() records each write, so abort() can put it back
  readonly range = transactional(signal('last-7-days'));
  readonly groupBy = transactional(signal('day'));

  // what the screen shows: frozen while a transaction holds the scope
  readonly shownRange = this.scope.hold(this.range);
  readonly shownGroupBy = this.scope.hold(this.groupBy);

  cancel: () => void = () => {};

  apply() {
    const txn = this.startTransaction(() => {
      this.range.set('last-30-days'); // live at once, requests refetch
      this.groupBy.set('week');
    });
    // if the user cancels: roll both writes back and release the hold
    this.cancel = () => txn.abort();
  }
}`;

  protected readonly retainEx = `this.startTransaction((tx) => {
  this.search.set(q); // results load from a debounced copy of search
  const release = tx.retain(); // stay open past the first render
  setTimeout(() => {
    try {
      tx.enter(() => this.debouncedSearch.set(q)); // the load starts in the transaction
    } finally {
      release(); // now it settles once that load is done
    }
  }, 300);
});`;

  protected readonly asyncTxEx = `readonly name = transactional(signal('Atlas'));
readonly revision = transactional(signal(1));
// the template reads these two
readonly shownName = this.scope.hold(this.name);
readonly shownRevision = this.scope.hold(this.revision);

save(next: string) {
  const t = this.startTransaction(async (tx) => {
    this.name.set(next); // before the first await: part of the transaction
    const saved = await api.rename(next);
    tx.enter(() => this.revision.set(saved.revision)); // back in for this slice
  });
  return t.done; // { kind: 'completed' | 'aborted' | 'failed', ... }, never rejects
}`;

  protected readonly composedEx = `// the template reads the held values
readonly shownName = this.scope.hold(this.name); // name = guessable(...)
readonly shownAddress = this.scope.hold(this.address); // transactional(signal(...))
readonly shownOrders = this.scope.hold(this.orders.value); // keepPrevious query

save() {
  this.startTransaction(async (tx) => {
    tx.guess(this.name, nextName); // shows at once, gone when this settles
    const saved = await this.rename.mutateAsync({ name: nextName });
    tx.enter(() => this.name.set(saved.name));
    try {
      await this.setAddress.mutateAsync(nextAddress); // invalidates orders
    } catch {
      return; // its failure stays in errored(), the old list stays up
    }
    tx.enter(() => this.address.set(nextAddress));
    const release = tx.retain(); // the orders refresh is debounced
    setTimeout(() => {
      try {
        tx.enter(() => this.ordersFor.set(nextAddress));
      } finally {
        release();
      }
    }, 300);
  });
}`;

  protected readonly failuresEx = `<mm-suspense>
  <span placeholder>Loading orders…</span>
  <!-- failed, nothing to show: replaces placeholder and content -->
  <p error>Could not load the orders. <button mmRetryFailed>Retry</button></p>
  <!-- failed, content held: renders beside it -->
  <div failed *mmSuspenseError="let entries; retry as retry; dismissAll as dismissAll">
    {{ entries[0].failure.displayName }} failed to refresh.
    <button (click)="retry()">Retry</button>
  </div>
  <orders-table />
</mm-suspense>`;

  protected readonly outcomeValueEx = `import { isError, isLoading } from '@mmstack/primitives';

const label = computed(() => {
  const out = user.outcome();
  if (isLoading(out)) return 'Loading…';
  if (isError(out)) return 'Could not load the user';
  return out?.name ?? 'No user selected';
});`;

  protected readonly joinedEx = `import { joined } from '@mmstack/primitives';

const card = joined(user, org, (u, o) => u.name + ' @ ' + o.name);
// card(): { kind: 'value', value } | { kind: 'pending', ... } | { kind: 'error', error }`;

  protected readonly revealEx = `<mm-reveal order="forwards" collapsed>
  <mm-suspense><app-profile /></mm-suspense>
  <mm-suspense><app-feed /></mm-suspense>
  <mm-suspense><app-suggestions /></mm-suspense>
</mm-reveal>`;

  protected readonly erroredEx = `<form *mmErrored="failed; name: 'order note'">
  <app-order-fields />
</form>

<ng-template #failed let-error let-retry="retry">
  <p>{{ error.message }} <button (click)="retry()">Retry</button></p>
</ng-template>`;

  protected readonly heldEffectEx = `import { heldEffect } from '@mmstack/primitives';

// runs once per settled change, not once per write
heldEffect(() => analytics.track('cart', cart.total()));`;

  protected readonly outcomeEx = `<mm-suspense>
  <span placeholder>Loading…</span>
  <h2 *mmOutcome="user; let u; error: failed">{{ u?.name }}</h2>
  <ng-template #failed let-error let-retry="retry">
    Could not load the user. <button (click)="retry?.()">Retry</button>
  </ng-template>
</mm-suspense>`;

  protected readonly guessEx = `const liked = guessable(signal(false));

startTransaction(async (tx) => {
  tx.guess(liked, true); // everyone sees true now
  const saved = await api.like(postId);
  tx.enter(() => liked.set(saved.liked)); // the server's answer, recorded
}); // the guess is gone once this settles, success or not`;

  protected readonly viewNameEx = `<!-- list view -->
<img [mmViewTransitionName]="'hero-' + item().id" [src]="item().thumb" />

<!-- detail view names the same element, so it morphs across the swap -->
<img [mmViewTransitionName]="'hero-' + item().id" [src]="item().full" />`;

  protected readonly keepPreviousEx = `import { holdUntilReady, keepPrevious } from '@mmstack/primitives';

// hold one value through a reload
const held = keepPrevious(myResource.value);

// hold a structure until the incoming one is ready
const shown = holdUntilReady(selectedId, () => !nextScope.pending());`;

  protected readonly deferredEx = `import { deferredValue } from '@mmstack/primitives';

const query = signal('');
// default 'afterRender' catches up next frame; 'idle' waits for the main
// thread to go idle, so heavy work never blocks the keystroke
const deferred = deferredValue(query, { strategy: 'idle' });

// bind the input to query() so it stays responsive,
// render the expensive list from deferred(),
// and dim it while deferred.pending() is true`;
}
