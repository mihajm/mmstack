import { Component } from '@angular/core';
import { SensorsDemo } from '@mmstack/demos';
import { CodeExample } from '../../../layout/code-example';
import { DemoBox } from '../../../layout/demo-box';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-sensors',
  imports: [DocPage, DocSection, CodeExample, DemoBox, SensorsDemo],
  template: `
    <docs-page
      title="Sensors"
      pkg="@mmstack/primitives"
      lead="Browser and device state, exposed as signals you can read in a template or a computed. Online status, media queries, element size, scroll, mouse position, and more."
    >
      <docs-section title="Why sensors" id="why">
        <p>
          Reading browser state normally means wiring up an event listener,
          copying the value into component state, and remembering to remove the
          listener on destroy. Do that for online/offline, a media query, and a
          <code>ResizeObserver</code> and you have three listeners, three
          fields, and three teardown paths to keep straight.
        </p>
        <p>
          A sensor collapses that to one call. It returns a plain signal that
          already tracks the underlying browser API, so you read it directly in
          a template or a <code>computed</code> and it updates when the state
          changes. The listener is attached for you and torn down through
          <code>DestroyRef</code> when the creating context is destroyed. On the
          server each sensor returns a stable fallback instead of touching an
          API that isn't there, so the same code renders under SSR.
        </p>
        <p>
          Reach for one whenever a piece of UI should react to the environment:
          a layout that changes at a breakpoint, a control that dims when the
          connection drops, a panel that measures itself.
        </p>
        <docs-demo title="Four sensors, live">
          @defer (on viewport) {
            <demo-sensors />
          } @placeholder {
            <p class="defer-hint">Demo loads on scroll.</p>
          }
        </docs-demo>
      </docs-section>

      <docs-section title="One call, one signal" id="example">
        <p>
          <code>sensor(type, options?)</code> creates a browser-state signal by
          name. Create it as a component field and read it like any other
          signal. Nothing else is required.
        </p>
        <docs-code [code]="example" lang="ts" />
        <p>
          Each sensor is also available as a standalone function
          (<code>networkStatus()</code>, <code>mediaQuery(q)</code>, and so on)
          if you would rather import it directly. The <code>sensor()</code>
          facade is the convenient entry point when you want one call and a
          consistent options bag.
        </p>
      </docs-section>

      <docs-section title="Three worth knowing" id="highlights">
        <p>
          A few sensors carry their weight in most apps. Each returns a signal,
          and some hang extra signals or methods off it.
        </p>
        <p>
          <code>mediaQuery</code> tracks a CSS media query and returns a
          <code>Signal&lt;boolean&gt;</code>, so you can drive a responsive
          layout from a <code>computed</code> instead of duplicating the
          breakpoint in CSS and TypeScript. <code>prefersDarkMode</code> (also
          reachable as <code>'dark-mode'</code>) and
          <code>prefersReducedMotion</code> are named shorthands for the common
          queries.
        </p>
        <docs-code [code]="mediaEx" lang="ts" />
        <p>
          <code>elementSize</code> wraps a <code>ResizeObserver</code> and
          defaults its target to the host element, so with no arguments it
          measures the component it lives in. It returns
          <code>{{ '{' }} width, height {{ '}' }} | undefined</code>
          (undefined until the first measurement). Pair it with a
          <code>computed</code> to switch a component between compact and full
          layouts based on its own width, not the viewport's.
        </p>
        <docs-code [code]="sizeEx" lang="ts" />
        <p>
          <code>networkStatus</code> returns a <code>Signal&lt;boolean&gt;</code>
          for online/offline, plus a <code>.since</code> signal holding the
          <code>Date</code> of the last transition. Use it to disable actions
          that need the network, or to show how long you have been offline.
        </p>
        <docs-code [code]="networkEx" lang="ts" />
      </docs-section>

      <docs-section title="Throttling and unthrottled reads" id="throttling">
        <p>
          Sensors that fire rapidly are throttled to 100ms by default:
          <code>windowSize</code>, <code>scrollPosition</code>,
          <code>mousePosition</code>, and <code>pointerDrag</code>. Pass
          <code>throttle</code> to change the window. When you need the exact,
          un-throttled value (a drop position, a precise scroll offset), read
          the <code>.unthrottled</code> view they expose alongside the throttled
          one.
        </p>
        <docs-code [code]="throttleEx" lang="ts" />
      </docs-section>

      <docs-section title="The full set" id="all">
        <p>
          Every sensor takes an options bag and, where it targets an element
          (<code>elementSize</code>, <code>elementVisibility</code>,
          <code>focusWithin</code>, <code>pointerDrag</code>), defaults
          <code>target</code> to the host so it is drop-in inside a component.
        </p>
        <table class="doc-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Returns</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>networkStatus</code></td>
              <td><code>Signal&lt;boolean&gt;</code> + <code>.since</code></td>
              <td>Online/offline. <code>.since</code> is the last transition.</td>
            </tr>
            <tr>
              <td><code>pageVisibility</code></td>
              <td><code>Signal&lt;DocumentVisibilityState&gt;</code></td>
              <td><code>'visible' | 'hidden' | 'prerender'</code>.</td>
            </tr>
            <tr>
              <td><code>mediaQuery</code></td>
              <td><code>Signal&lt;boolean&gt;</code></td>
              <td>Generic CSS media query. <code>query</code> is required.</td>
            </tr>
            <tr>
              <td><code>dark-mode</code></td>
              <td><code>Signal&lt;boolean&gt;</code></td>
              <td>Shorthand for <code>(prefers-color-scheme: dark)</code>.</td>
            </tr>
            <tr>
              <td><code>reduced-motion</code></td>
              <td><code>Signal&lt;boolean&gt;</code></td>
              <td>Shorthand for <code>(prefers-reduced-motion: reduce)</code>.</td>
            </tr>
            <tr>
              <td><code>windowSize</code></td>
              <td><code>Signal&lt;{{ '{' }} width, height {{ '}' }}&gt;</code> + <code>.unthrottled</code></td>
              <td>Throttled 100ms.</td>
            </tr>
            <tr>
              <td><code>scrollPosition</code></td>
              <td><code>Signal&lt;{{ '{' }} x, y {{ '}' }}&gt;</code> + <code>.unthrottled</code></td>
              <td>Window or element scroll, throttled 100ms.</td>
            </tr>
            <tr>
              <td><code>mousePosition</code></td>
              <td><code>Signal&lt;{{ '{' }} x, y {{ '}' }}&gt;</code> + <code>.unthrottled</code></td>
              <td>Throttled 100ms. <code>coordinateSpace: 'client' | 'page'</code>.</td>
            </tr>
            <tr>
              <td><code>pointerDrag</code></td>
              <td><code>Signal&lt;PointerDragState&gt;</code> + <code>.unthrottled</code> + <code>.cancel()</code></td>
              <td>Pointer gesture with <code>activationThreshold</code> and <code>delta</code>.</td>
            </tr>
            <tr>
              <td><code>elementSize</code></td>
              <td><code>Signal&lt;{{ '{' }} width, height {{ '}' }} | undefined&gt;</code></td>
              <td><code>ResizeObserver</code>-based. Defaults to the host.</td>
            </tr>
            <tr>
              <td><code>elementVisibility</code></td>
              <td><code>Signal&lt;IntersectionObserverEntry?&gt;</code> + <code>.visible</code></td>
              <td><code>IntersectionObserver</code>-based; <code>.visible</code> is a boolean.</td>
            </tr>
            <tr>
              <td><code>focusWithin</code></td>
              <td><code>Signal&lt;boolean&gt;</code></td>
              <td>Mirrors <code>:focus-within</code>.</td>
            </tr>
            <tr>
              <td><code>geolocation</code></td>
              <td><code>Signal&lt;GeolocationPosition?&gt;</code> + <code>.error</code> + <code>.loading</code></td>
              <td>One-shot by default; <code>watch: true</code> for continuous.</td>
            </tr>
            <tr>
              <td><code>clipboard</code></td>
              <td><code>Signal&lt;string&gt;</code> + <code>.copy(v)</code> + <code>.isSupported</code></td>
              <td>Mirrors clipboard contents; <code>.copy</code> writes through.</td>
            </tr>
            <tr>
              <td><code>orientation</code></td>
              <td><code>Signal&lt;{{ '{' }} angle, type {{ '}' }}&gt;</code></td>
              <td>Tracks <code>screen.orientation</code>.</td>
            </tr>
            <tr>
              <td><code>batteryStatus</code></td>
              <td><code>Signal&lt;BatteryStatus | null&gt;</code></td>
              <td><code>null</code> until (or unless) the API resolves.</td>
            </tr>
            <tr>
              <td><code>idle</code></td>
              <td><code>Signal&lt;boolean&gt;</code> + <code>.since</code></td>
              <td>Flips <code>true</code> after <code>ms</code> of inactivity.</td>
            </tr>
          </tbody>
        </table>
      </docs-section>

      <docs-section title="Several at once" id="bulk">
        <p>
          When one consumer needs a handful of them,
          <code>sensors([...])</code> creates several in one call and returns
          them keyed by type, with optional per-sensor options.
        </p>
        <docs-code [code]="bulk" lang="ts" />
      </docs-section>

      <docs-section title="signalFromEvent" id="signal-from-event">
        <p>
          Most sensors are shaped from <code>signalFromEvent</code>, a generic
          <code>EventTarget</code> to signal helper. It is not on the
          <code>sensor()</code> facade because it takes positional arguments
          rather than an options bag, but it is there when you need to track an
          event the built-in sensors do not cover. The optional projector plucks
          just the data you want, and the target can itself be a signal, so the
          listener moves when it flips.
        </p>
        <docs-code [code]="eventEx" lang="ts" />
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
export class SensorsDoc {
  protected readonly example = `import { Component } from '@angular/core';
import { DatePipe } from '@angular/common';
import { sensor } from '@mmstack/primitives';

@Component({
  selector: 'app-network-badge',
  imports: [DatePipe],
  template: \`
    @if (network()) {
      <span>Online since {{ '{{' }} network.since() | date: 'short' {{ '}}' }}</span>
    } @else {
      <span>Offline since {{ '{{' }} network.since() | date: 'short' {{ '}}' }}</span>
    }
  \`,
})
export class NetworkBadge {
  protected readonly network = sensor('networkStatus');
}`;

  protected readonly mediaEx = `import { computed } from '@angular/core';
import { sensor } from '@mmstack/primitives';

const desktop = sensor('mediaQuery', { query: '(min-width: 1024px)' });
const dark = sensor('dark-mode'); // Signal<boolean>

const columns = computed(() => (desktop() ? 3 : 1));`;

  protected readonly sizeEx = `import { computed } from '@angular/core';
import { sensor } from '@mmstack/primitives';

// no argument: measures the host element via ResizeObserver
const box = sensor('elementSize');

const layout = computed(() => {
  const width = box()?.width ?? 0; // undefined until first measurement
  return width < 480 ? 'compact' : 'full';
});`;

  protected readonly networkEx = `import { sensor } from '@mmstack/primitives';

const online = sensor('networkStatus');
online();       // boolean
online.since(); // Date of the last online/offline flip`;

  protected readonly throttleEx = `import { sensor } from '@mmstack/primitives';

const mouse = sensor('mousePosition', { coordinateSpace: 'page', throttle: 50 });
mouse();             // throttled { x, y }
mouse.unthrottled(); // exact current coordinates

const size = sensor('windowSize', { throttle: 200 }); // widen the window`;

  protected readonly bulk = `import { sensors } from '@mmstack/primitives';

const { networkStatus, windowSize } = sensors(
  ['networkStatus', 'windowSize'],
  { windowSize: { throttle: 200 } },
);`;

  protected readonly eventEx = `import { signalFromEvent } from '@mmstack/primitives';

// project just the coordinates off each mousemove
const point = signalFromEvent<MouseEvent, { x: number; y: number }>(
  document,
  'mousemove',
  { x: 0, y: 0 },
  (e) => ({ x: e.clientX, y: e.clientY }),
);`;
}
