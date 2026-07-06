import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-dnd-advanced',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Advanced"
      pkg="@mmstack/dnd"
      lead="The surface beyond a draggable and a sortable list: watch drags globally, accept files from the OS, restrict where a drag starts, customize the preview, tune accessibility, and set defaults for a whole app."
    >
      <docs-section title="When to reach here" id="when">
        <p>
          The
          <a mmLink="/docs/dnd/elements">draggables and drop targets</a> page
          and the <a mmLink="/docs/dnd/reorderable">sortable lists</a> page
          cover the common cases: carry a typed payload, narrow it on a target,
          splice an array on drop. This page is for the rest.
        </p>
        <p>
          Reach for it to react to a drag from an element that is neither the
          source nor a target, accept files a user drags in from their desktop,
          start a drag from a grip inside a larger row, swap the image that
          follows the cursor, adjust the screen-reader narration, or set a
          convention like the pointer engine once instead of at every call site.
        </p>
      </docs-section>

      <docs-section title="Watch drags globally with monitor" id="monitor">
        <p>
          <code>monitor()</code> observes the ambient drag session without the
          host being a draggable or a drop target. It returns
          <code>isDragging()</code> and <code>source()</code>, both derived from
          the session, so there is no subscription unless you ask for one. Use
          it for a drag-aware cursor, a "drop somewhere" hint, or a bit of
          analytics.
        </p>
        <docs-code [code]="monitorEx" lang="ts" />
        <p>
          Pass an <code>accepts</code> type guard to report only the drags you
          care about, and <code>source()</code> is narrowed to that type while a
          matching drag is in flight. If you also need a side effect at the
          edges, pass <code>onDragStart</code> or <code>onDrop</code>; those
          (and only those) attach a thin subscription. For a lower-level view of
          the same session there are <code>injectDndActive()</code>,
          <code>injectDndPointer()</code>, <code>injectDndTargets()</code>, and
          the writable <code>injectDndSession()</code>.
        </p>
      </docs-section>

      <docs-section title="Files and external drops" id="files">
        <p>
          <code>fileDropTarget()</code> makes the host accept files dragged in
          from outside the browser (the OS, another app). It derives
          <code>isDragOver()</code> and <code>isInnermost()</code> like a normal
          target, and <code>onDrop</code> hands you the extracted
          <code>File[]</code> through a <code>FileDropEvent</code>.
        </p>
        <docs-code [code]="fileDropEx" lang="ts" />
        <p>
          A <code>canDrop</code> gate can inspect the drag's media
          <code>types</code> before accepting, and <code>sticky</code> /
          <code>dropEffect</code> behave as they do on a normal target. To watch
          external drags without being a target, use
          <code>monitorExternal()</code>, whose <code>isDragging()</code> tracks
          any file drag on the page.
        </p>
        <docs-code [code]="monitorExternalEx" lang="ts" />
        <p>
          This is a native-engine capability: files, cross-window drags, and the
          browser's own drag image all run through HTML5 drag-and-drop, which
          the native engine wraps. An element can be both a normal drop target
          and a file target at once. Apply both composables to the same host.
        </p>
      </docs-section>

      <docs-section title="Drag from a handle" id="handle">
        <p>
          By default the whole draggable element starts a drag. To limit that to
          a grip, put <code>mmDragHandle</code> on a child, capture it with a
          template reference, and pass it to the draggable's
          <code>dragHandle</code> input. The rest of the row stays clickable and
          selectable.
        </p>
        <docs-code [code]="handleEx" label="template" lang="html" />
        <p>
          This is the element-layer counterpart to the reorderable handle you
          saw on the <a mmLink="/docs/dnd/reorderable">sortable lists</a> page.
          The directive is the <code>DragHandle</code> class;
          <code>mmDragHandle</code> scopes any <code>mmDraggable</code>, and the
          reorderable version does the same for a list row.
        </p>
      </docs-section>

      <docs-section title="Custom preview" id="preview">
        <p>
          The <code>preview</code> option on a draggable controls what follows
          the pointer. A <code>PreviewConfig</code> is one of three shapes: a
          component (<code>{{ '{' }} component, bindings? {{ '}' }}</code
          >), a template (<code>{{ '{' }} template, context? {{ '}' }}</code
          >), or a raw <code>render</code> callback for full control. Each takes
          an optional <code>offset</code>.
        </p>
        <docs-code [code]="previewEx" lang="ts" />
        <p>
          <code>PreviewOffset</code> is either
          <code>'pointer-outside'</code> (sit just off the cursor) or a fixed
          <code>{{ '{' }} x, y {{ '}' }}</code
          >. On the native engine this renders into the browser's custom drag
          image; on the pointer engine there is no native image, so the same
          config renders a floating follower the library positions itself. The
          <code>bindings</code> array uses <code>inputBinding</code>,
          <code>outputBinding</code>, and <code>twoWayBinding</code> from
          <code>&#64;angular/core</code>, so inputs stay reactive.
        </p>
      </docs-section>

      <docs-section title="Accessibility" id="a11y">
        <p>
          Keyboard reordering and screen-reader announcements are on by default
          for reorderable lists. Focus a row, arrow keys move it one step, and
          the move is narrated through a shared ARIA live region. You do not opt
          in.
        </p>
        <p>
          To narrate your own operations (a delete, a cross-list move, a custom
          command), call <code>injectAnnounce()</code>. It returns the active
          announcer: a plugin you registered through <code>provideDnd</code>, or
          the built-in zero-dependency one otherwise. The message defaults to
          <code>'polite'</code>; pass <code>'assertive'</code> (a
          <code>Politeness</code> value) for something that should interrupt.
        </p>
        <docs-code [code]="announceEx" lang="ts" />
        <p>
          To opt out on a list, set <code>keyboard: false</code> (no tabindex,
          no handler) or <code>announceMove: false</code> (no live region). To
          replace the announcer app-wide, register an <code>announce</code>
          plugin (for example Atlassian's live-region package) through
          <code>provideDnd</code>, and every <code>injectAnnounce()</code> call
          picks it up.
        </p>
        <docs-code [code]="announcePluginEx" lang="ts" />
      </docs-section>

      <docs-section title="Auto-scroll" id="auto-scroll">
        <p>
          When a drop area is taller than its viewport, you want it to scroll as
          the pointer nears an edge. The <code>mmAutoScroll</code> directive
          turns that on for a scrollable host, and <code>autoScroll()</code> is
          its composable form for a component that owns the element. It needs an
          auto-scroll plugin registered (see App-wide defaults below); without
          one it warns once in dev and no-ops.
        </p>
        <docs-code [code]="autoScrollEx" label="template" lang="html" />
        <p>
          <code>AutoScrollOptions</code> lets you point it at a different
          <code>element</code>, override the resolved plugin, or pass an
          <code>injector</code> to run outside an injection context. Any extra
          keys pass through to the plugin. This is the element-layer scroll: a
          reorderable list has its own <code>autoScroll</code> option that
          drives the same plugin, so you rarely need this directive on a
          sortable.
        </p>
      </docs-section>

      <docs-section title="Drop indicator" id="drop-indicator">
        <p>
          On the native engine a sortable does not move its items; it draws an
          insertion line where the drop will land. That line is the
          <code>DropIndicator</code> component,
          <code>&lt;mm-drop-indicator&gt;</code>. The reorderable directives
          render it for you, so you only reach for it directly on a hand-built
          native drop target: overlay it on a
          <code>position: relative</code> element and drive its
          <code>edge</code> input from a target's <code>closestEdge()</code>.
        </p>
        <docs-code [code]="dropIndicatorEx" label="template" lang="html" />
        <p>
          It positions itself with encapsulated styles (no global stylesheet),
          and reads the edge reactively, so binding
          <code>[edge]="dt.closestEdge()"</code> is all it takes. Color comes
          from the <code>--mm-drop-indicator-color</code> custom property.
        </p>
      </docs-section>

      <docs-section title="Scoped sessions" id="scoped-session">
        <p>
          The drag session lives in the root injector, so the library works with
          no setup and a drag on one part of the page is visible everywhere.
          When a subtree needs its own coordinate space, one that does not see
          or interfere with drags elsewhere, add
          <code>provideDndSession()</code> to that component's
          <code>providers</code>. The <code>injectDnd*</code> helpers inside it
          then resolve to the scoped session instead of the root one.
        </p>
        <docs-code [code]="sessionEx" lang="ts" />
      </docs-section>

      <docs-section title="App-wide defaults" id="defaults">
        <p>
          Two provider families let a team set conventions once. Use
          <code>provideDnd()</code> to register the optional plugins (edge
          detection, auto-scroll, post-move flash, a replacement announcer) and
          to scope a session. Use the defaults providers to fill option values
          so you stop repeating them at every call.
        </p>
        <docs-code [code]="provideDndEx" lang="ts" />
        <p>
          <code>provideDndDefaults()</code> holds the cross-primitive defaults
          (currently <code>engine</code>), so one line flips your whole app to
          the pointer engine. Each primitive also has its own provider for
          options only it understands, and it inherits the common defaults
          unless it sets that key itself.
        </p>
        <docs-code [code]="defaultsEx" lang="ts" />
        <p>
          Resolution runs most-specific first: per-call option, then the
          per-primitive default, then <code>provideDndDefaults</code>, then the
          built-in. Each provider takes a value or a factory, and each has a
          matching reader (<code>injectDndDefaults</code> and friends) that
          returns the resolved defaults or <code>null</code>. Pass an
          <code>Injector</code> to read outside an injection context.
        </p>
      </docs-section>

      <docs-section title="Testing" id="testing">
        <p>
          Because per-element state is derived from the one ambient session,
          most behaviour is unit-testable with no drag simulation: set the
          session and assert the derived signals.
          <code>injectDndSession()</code> returns the writable session, and
          <code>boxData</code> builds a source payload the way the library boxes
          it internally (under a private symbol), so a target's
          <code>accepts</code> and the derived <code>isDragOver()</code> see the
          real shape.
        </p>
        <docs-code [code]="testingEx" lang="ts" />
        <p>
          The reorderable controller is testable the same way, and without a
          DOM.
          <code>reorderable(signal, opts)</code> is a pure controller: drive its
          <code>begin</code> / <code>move</code> / <code>end</code> and read the
          per-item state signals directly.
        </p>
      </docs-section>

      <docs-section title="Open core" id="open-core">
        <p>
          The primitives on these pages cover the common shapes, but
          drag-and-drop has a long tail. When a shipped primitive does not fit,
          you do not have to rebuild the plumbing. The barrel also exports the
          pieces the library is built from: the gesture chassis
          (<code>driveGesture</code>) and the geometry and hit-testing helpers
          behind the sortable, grid, and canvas, that way you can assemble a
          bespoke interaction on the same reactive session everything else reads.
        </p>
        <p>
          These helpers are not documented symbol by symbol, on purpose: keeping
          them out of the reference keeps the surface you learn small. They are
          typed and discoverable straight from the barrel, so an editor
          autocomplete on <code>&#64;mmstack/dnd</code> is the map.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class DndAdvancedDoc {
  protected readonly monitorEx = `import { monitor } from '@mmstack/dnd';

type Card = { id: string; title: string };
const isCard = (d: unknown): d is Card =>
  !!d && typeof d === 'object' && 'id' in d;

// derived: no subscription, recomputes only when the session changes
protected readonly drags = monitor<Card>({ accepts: isCard });
// template: <div [class.is-dragging]="drags.isDragging()">
// drags.source() is { data: Card; meta } | undefined while a Card drags`;

  protected readonly fileDropEx = `import { fileDropTarget } from '@mmstack/dnd';

@Component({ host: { '[class.over]': 'drop.isDragOver()' } })
export class Uploader {
  protected readonly drop = fileDropTarget({
    canDrop: ({ types }) => types.includes('Files'),
    onDrop: ({ files }) => this.upload(files), // files: File[]
  });
}`;

  protected readonly monitorExternalEx = `import { monitorExternal } from '@mmstack/dnd';

// true whenever a file drag is anywhere on the page
protected readonly external = monitorExternal({
  onDrop: ({ files }) => this.stash(files),
});`;

  protected readonly handleEx = `<li
  mmDraggable
  [data]="item()"
  [dragHandle]="grip"
  #d="mmDraggable"
  [class.dragging]="d.dragging()"
>
  <span mmDragHandle #grip="mmDragHandle">::</span>
  {{ item().label }}
</li>`;

  protected readonly previewEx = `import { draggable } from '@mmstack/dnd';

// a template preview, anchored just off the cursor
protected readonly dnd = draggable<Card>({
  data: this.card,
  preview: () => ({
    template: this.previewTpl(),
    context: this.card(),
    offset: 'pointer-outside',
  }),
});
// or { component, bindings }, or { render } for a raw container`;

  protected readonly announceEx = `import { injectAnnounce } from '@mmstack/dnd';

const announce = injectAnnounce();

reorderable(this.items, {
  key: (c) => c.id,
  onReorder: ({ to, items }) =>
    announce(\`\${items[to].label} moved to position \${to + 1}\`),
});

// something urgent should interrupt:
announce('Upload failed', 'assertive');`;

  protected readonly announcePluginEx = `import { provideDnd } from '@mmstack/dnd';
import { announce as liveRegionAnnounce } from '@atlaskit/pragmatic-drag-and-drop-live-region';

provideDnd({ plugins: { announce: liveRegionAnnounce } });
// every injectAnnounce() now returns this announcer instead of the built-in`;

  protected readonly provideDndEx = `import { provideDnd } from '@mmstack/dnd';
import { closestEdge, edgeAutoScroll } from '@mmstack/dnd/plugins';

bootstrapApplication(App, {
  providers: [
    provideDnd({
      plugins: {
        hitbox: closestEdge, // enables edge-aware drops
        autoScroll: edgeAutoScroll, // scroll near a container edge
      },
    }),
  ],
});`;

  protected readonly defaultsEx = `import {
  provideDndDefaults,
  provideDraggableDefaults,
  provideDropTargetDefaults,
} from '@mmstack/dnd';

provideDndDefaults({ engine: 'pointer' }); // every primitive goes pointer
provideDraggableDefaults({ engine: 'native' }); // except draggables, kept native
provideDropTargetDefaults({ sticky: true, dropEffect: 'copy' });`;

  protected readonly autoScrollEx = `<!-- directive on a scrollable container -->
<div mmAutoScroll style="overflow:auto; max-height:300px">…</div>

<!-- or the composable form, for a component that owns the element -->
<!-- import { autoScroll } from '@mmstack/dnd'; constructor() { autoScroll(); } -->`;

  protected readonly dropIndicatorEx = `<li
  mmDropTarget
  #dt="mmDropTarget"
  [edges]="['top', 'bottom']"
  style="position: relative"
>
  …
  <mm-drop-indicator [edge]="dt.closestEdge()" />
</li>`;

  protected readonly sessionEx = `import { provideDndSession } from '@mmstack/dnd';

@Component({
  providers: [provideDndSession()], // an independent session for this subtree
})
export class BoardComponent {}`;

  protected readonly testingEx = `import { injectDndSession, boxData } from '@mmstack/dnd';

const session = TestBed.runInInjectionContext(() => injectDndSession());
session.set({
  sourceEl,
  sourceData: boxData(card), // boxed the same way the library boxes it
  targets: [{ element: el, data: {} }],
  pointer: { x: 0, y: 0 },
  kind: 'transfer',
  engine: 'native',
});
expect(zone.isDragOver()).toBe(true);`;
}
