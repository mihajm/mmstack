# @mmstack/telemetry-devtools

> **Experimental.** The API may still change and this package is not yet battle-tested in production. Pin a version and expect some churn.

Chrome DevTools adapter for [`@mmstack/telemetry-core`](https://www.npmjs.com/package/@mmstack/telemetry-core). It draws your app's spans, events, and findings as named tracks in the Performance panel, next to Chrome's own main-thread and network tracks.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)

## Install

```bash
npm install @mmstack/telemetry-devtools
```

No dependencies. The sink uses the browser's `console.timeStamp` and `performance.measure`. During SSR, or where neither API exists, the factory returns `null` and the facade drops the sink.

## Usage

```ts
import { provideTelemetry } from '@mmstack/telemetry-core';
import { devtoolsSink } from '@mmstack/telemetry-devtools';

provideTelemetry({
  sinks: [devtoolsSink()],
});
```

Open the Performance panel, record, and use the app. The entries show up under a `mmstack` track group (change it with `group`).

## Same records, second rendering

This sink shows the records every other sink receives. It adds no data of its own. A span's label is its name, prefixed with `formatOrigin(origin)` when it ran under `withOrigin`, for example `click on button#next · wizard.next`. An event's label is its name. A finding's label is `CODE: message`, cut to 120 characters, with the full message as the tooltip. Because the origin text comes from the same `formatOrigin` that other renderers use, the panel and your dashboards show the same words.

By default each kind has one track: spans go to `Spans`, events to `Events`, findings to `Findings`. A string `track` attr moves an entry to the track it names, for example `{ track: 'Interactions' }`. A `track` callback overrides both. Spans are `primary`, or `error` when they failed. Events are `secondary`. Findings are `tertiary`, `warning`, or `error` by severity. A `color` callback overrides that, and it sees `error: true` for a failed span.

## Two modes

- `'rich'` (the default in dev mode) calls `performance.measure` with Chrome's `devtools` detail, so entries carry a colour, a tooltip, and a property table built from their primitive attrs. The panel captures an entry when it is made, so the sink clears the labels it emitted in one microtask after each burst. Your User Timing buffer does not grow. The trade-off: those measures are gone from `performance.getEntriesByType('measure')` and from any `PerformanceObserver` that reads them later.
- `'cheap'` (the default otherwise) calls `console.timeStamp(label, start, end, track, group, color)`. Nothing is retained and there are no tooltips or properties.

When only one of the two APIs exists, the sink uses that one, whatever the `mode`.

## Clock

The facade stamps spans in epoch milliseconds. Chrome wants milliseconds since `performance.timeOrigin`, so the sink subtracts it. A span is drawn once, when it ends, from its own start and end stamps. A span buffered while a sink was not ready still lands at the time it ran. Events and findings carry no stamp, so they are drawn at the moment the sink receives them.

## Seeding

Tracks appear in the order their first entry arrives, so they can shuffle between recordings. To keep them stable, the sink draws one zero-length entry per seeded track at 0.003 ms, in order, when it is created. The default seed is `['Spans', 'Events', 'Findings']`. A `seed` you pass replaces it entirely, so add your own tracks to it (`seed: ['Interactions', 'Spans', 'Events', 'Findings']`) or pass `[]` to seed nothing.

## Verification

The unit tests check the exact arguments passed to `console.timeStamp` and `performance.measure`.

A Playwright spec in the repo, `apps/playground-e2e/src/telemetry-devtools.spec.ts`, checks what Chrome keeps. It opens the playground's telemetry page in Chromium, records a trace over the Chrome DevTools Protocol, clicks, and asserts on the trace events the Performance panel is drawn from. In `'rich'` mode it checks the label, track, `mmstack` group, colour, and properties of a span and a finding, the finding's tooltip, that seeds are zero-length and emitted in seed order, that a span sits inside the click that caused it, and that a measure the sink cleared from `performance.getEntriesByName` is still in the trace. In `'cheap'` mode it checks the `console.timeStamp` entry's label, track, group, and colour, and that each seed is present and zero-length.

Run it with `nx run playground-e2e:e2e --testFiles=telemetry-devtools.spec.ts --project=chromium`. It is not part of this package's `test` target. It needs Playwright's Chromium (`npx playwright install chromium`) and starts the playground dev server itself. On other browsers the tests skip, because CDP tracing is Chromium-only.

The spec stops at the trace. How the Performance panel draws those events is not tested, and is still checked by eye in the playground.
