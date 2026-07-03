import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-primitives-performance',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Performance"
      pkg="@mmstack/primitives"
      lead="Two ways to keep a hot path off the critical frame: time-slice a large computation so it does not block, and recycle allocations so a derivation that runs constantly stops churning the garbage collector."
    >
      <docs-section title="chunked, work spread over frames" id="chunked">
        <p>
          You have a signal holding a large array and something downstream that
          is expensive per item: a <code>&#64;for</code> that renders a heavy row,
          a computation that walks the whole list. Feeding all of it in at once
          means one long frame and a visible stall while the browser catches up.
        </p>
        <p>
          <code>chunked</code> returns a signal that reveals the source array a
          slice at a time. The first read gives you the first
          <code>chunkSize</code> items right away, then it schedules the next
          slice on the next frame, and the next, until the whole array is
          present. Downstream work sees a growing list and stays responsive
          between slices instead of paying for everything on one tick.
        </p>
        <docs-code [code]="chunkedEx" lang="ts" />
        <p>
          The default delay is <code>'frame'</code> (a
          <code>requestAnimationFrame</code> between slices); pass a number of
          milliseconds or <code>'microtask'</code> to change the cadence. It
          also takes the shared <code>pause</code> option, so under an
          <a mmLink="/docs/primitives/pausing"><code>*mmActivity</code></a>
          boundary the scheduling stops while the subtree is hidden and resumes
          from the slice it reached, rather than churning through the list for a
          view nobody is looking at.
        </p>
        <p>
          Reach for it when a list is large enough that mounting it in one go
          drops a frame. For a list that fits comfortably in a frame this only
          adds latency to the tail, so leave it off.
        </p>
      </docs-section>

      <docs-section title="Object pools for hot derivations" id="pools">
        <p>
          A <code>computed</code> that builds a fresh array, <code>Set</code>, or
          <code>Map</code> every time it runs allocates a new container on every
          recomputation. For a derivation that fires many times a second (a
          filter over a live list, an aggregate recomputed on every keystroke)
          that steady allocation is pressure the garbage collector has to clean
          up later, in pauses you do not control.
        </p>
        <p>
          <code>pooled</code> backs a signal with a two-slot buffer pool. It
          allocates the container at most twice over the whole life of the
          signal and swaps between the two on each recompute, resetting the
          dirty one before your computation writes into it. Consecutive reads
          still return different instances, so ordinary <code>Object.is</code>
          equality keeps flagging changes; you just stop minting a new object
          each time.
        </p>
        <docs-code [code]="pooledEx" lang="ts" />
        <p>
          The tradeoff is the retention contract: the value a pooled signal
          hands you is only valid until its next recomputation, when the
          container is recycled and overwritten. Do not store it, hand it to
          async code, or pass it to anything that outlives the current reactive
          tick. Read it, derive from it, and let it go.
        </p>
        <p>
          The common containers have presets so you skip the
          <code>create</code>/<code>reset</code> boilerplate:
          <code>pooledArray</code>, <code>pooledMap</code>, and
          <code>pooledSet</code> each supply their own factory and reset
          (<code>length = 0</code> for arrays, <code>.clear()</code> for the
          rest). Pass a computation function for the common case, or the full
          options object when you need <code>eager</code> pre-allocation or a
          custom container.
        </p>
        <docs-code [code]="pooledArrayEx" lang="ts" />
        <p>
          Use a pool only where the allocation actually shows up in a profile:
          a hot, high-frequency derivation whose output is consumed and dropped
          within the same tick. For anything read once and kept, a plain
          <code>computed</code> is simpler and the retention contract does not
          get in your way.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class PerformanceDoc {
  protected readonly chunkedEx = `import { signal } from '@angular/core';
import { chunked } from '@mmstack/primitives';

const rows = signal(loadThousandsOfRows());

// reveals 100 rows per frame instead of all at once
const visible = chunked(rows, { chunkSize: 100 });

// render @for over visible(); it grows across frames, no long stall`;

  protected readonly pooledEx = `import { signal } from '@angular/core';
import { pooled } from '@mmstack/primitives';

const items = signal<{ active: boolean }[]>([]);

const counts = pooled<{ total: number; active: number }>({
  create: () => ({ total: 0, active: 0 }),
  reset: (c) => {
    c.total = 0;
    c.active = 0;
  },
  computation: (c) => {
    for (const item of items()) {
      c.total++;
      if (item.active) c.active++;
    }
    return c;
  },
});`;

  protected readonly pooledArrayEx = `import { signal } from '@angular/core';
import { pooledArray } from '@mmstack/primitives';

const items = signal<{ id: number; active: boolean }[]>([]);

// recycles one array per slot; just write into the buffer and return it
const activeIds = pooledArray<number[]>((buf) => {
  for (const item of items()) if (item.active) buf.push(item.id);
  return buf;
});`;
}
