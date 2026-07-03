import { Component } from '@angular/core';
import { KeepAliveDemo } from '@mmstack/demos';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-pausing',
  imports: [DocPage, DocSection, CodeExample, DemoBox, KeepAliveDemo, Link],
  template: `
    <docs-page
      title="Keep-alive and pausing"
      pkg="@mmstack/primitives"
      lead="Keep a hidden tab or route mounted so its state survives, and stop the work inside it from running while nobody is looking. The Angular analog of React's Activity and Vue's keep-alive."
    >
      <p>
        Switch away from a tab built with <code>&#64;switch</code> and the old
        branch is destroyed: scroll position, half-filled inputs, a paused video,
        and loaded data all reset when you come back. Leave it mounted instead
        and the opposite problem appears, since its pollers, effects, and
        recomputes keep running in the background. These tools handle both.
      </p>

      <docs-section title="mmActivity keeps a subtree alive" id="activity">
        <p>
          <code>*mmActivity</code> mounts its subtree once and keeps it. While
          the condition is false the subtree is hidden with
          <code>display: none</code> and its change detection is paused, so state
          is preserved. When it is true again the view shows and change
          detection resumes. Nothing is destroyed until the directive itself is.
        </p>
        <docs-code [code]="activity" lang="html" />
        <p>
          This is the fix for a tabbed editor or a wizard where losing what the
          user typed on step two is unacceptable. Unlike a plain
          <code>&#64;if</code> or <code>&#64;switch</code>, the branch is never
          torn down.
        </p>
      </docs-section>

      <docs-section title="The paused context" id="paused">
        <p>
          <code>*mmActivity</code> also provides a paused context to its subtree,
          the negation of the visible condition. Read it anywhere below with
          <code>injectPaused()</code>, a <code>Signal&lt;boolean&gt;</code> that
          is <code>true</code> while hidden.
        </p>
        <docs-code [code]="paused" lang="ts" />
        <p>
          Pausing change detection stops pull-based work for free (templates and
          the computeds they read), but it does not stop <code>effect()</code>s
          or RxJS timers. A poller inside a hidden tab keeps polling unless you
          gate it on <code>injectPaused()</code>, use the pausable primitives
          below, or use a resource that respects the paused context.
          <code>providePaused(signal)</code> sets up your own boundary without
          <code>*mmActivity</code>. On the server nothing is ever paused, so the
          full tree renders.
        </p>
      </docs-section>

      <docs-section title="Pausable primitives" id="pausable">
        <p>
          <code>pausableSignal</code>, <code>pausableComputed</code>, and
          <code>pausableEffect</code> are drop-in versions that suspend while
          paused. By default they read the ambient paused context, so dropping
          them inside an <code>*mmActivity</code> subtree just works. Pass
          <code>pause</code> for an explicit source, or
          <code>pause: false</code> to opt out, which returns the bare primitive
          with no wrapper overhead.
        </p>
        <docs-code [code]="pausable" lang="ts" />
        <p>
          A paused computed holds its last value and does not recompute. A paused
          effect skips its body, and its dependencies collapse so a change cannot
          wake it until it resumes. Writes to a paused signal still land and
          surface on resume.
        </p>
        <p>
          Both frames below read the same signal, ticking on a
          <code>setInterval</code>. The right one is a
          <code>pausableComputed</code> bound to the button. Pause it and the
          count freezes while the live frame keeps going, then it catches up in
          one step on resume.
        </p>
        <docs-demo title="Pause a running computation">
          @defer (on viewport) {
            <demo-keep-alive />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
      </docs-section>

      <docs-section title="Setting a default pause source" id="default-pause">
        <p>
          <code>providePausableOptions</code> is a provider, not a global
          switch. It sets the default <code>pause</code> for every
          pausable-aware primitive within its injector scope, the
          <code>pausable*</code> family plus the opt-in integrations in
          <code>stored</code> and <code>chunked</code>. Like a suspense or pause
          boundary, it applies from where you provide it down the tree, and a
          nested <code>providePausableOptions</code> overrides it for that
          subtree. A call-site <code>pause</code> always wins. Provide it at the
          app root to make it the default everywhere, or on a route or component
          to scope it there.
        </p>
        <docs-code [code]="appWide" lang="ts" />
        <p>
          <code>pause: true</code> means honor the ambient paused context, so it
          needs an <code>*mmActivity</code> or <code>providePaused</code>
          boundary above it to supply the paused state. The two compose: the
          boundary decides when its subtree is paused, and this decides which
          primitives listen.
        </p>
        <p>
          Data fetching plugs into the same context.
          <a mmLink="/docs/resource">&#64;mmstack/resource</a> resources pause
          their polling and refetch triggers when the context is paused, and you
          can opt every query into it from one provider. This composes with
          <a mmLink="/docs/primitives/transitions">transitions</a>: a paused
          subtree does no background work, and a visible one still holds and
          swaps cleanly.
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
export class PausingDoc {
  protected readonly activity = `<section *mmActivity="tab() === 'editor'">
  <app-editor />  <!-- mounted once; state survives while another tab is open -->
</section>`;

  protected readonly paused = `import { injectPaused } from '@mmstack/primitives';

// anywhere under an *mmActivity subtree
readonly paused = injectPaused(); // Signal<boolean>, true while hidden

constructor() {
  effect(() => {
    if (this.paused()) return; // skip background work while hidden
    poll(this.url());
  });
}`;

  protected readonly pausable = `import {
  pausableSignal,
  pausableComputed,
  pausableEffect,
} from '@mmstack/primitives';

const scroll = pausableSignal(0);                        // reads hold while paused
const total = pausableComputed(() => expensive(data())); // does not recompute while paused
pausableEffect(() => poll(url()));                       // body skipped while paused`;

  protected readonly appWide = `import { providePausableOptions } from '@mmstack/primitives';

// within this injector scope, default pausable-aware primitives to honor
// the nearest paused boundary (an *mmActivity or providePaused above)
providers: [providePausableOptions({ pause: true })];`;
}
