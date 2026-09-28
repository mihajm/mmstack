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

The unit tests check the exact arguments passed to `console.timeStamp` and `performance.measure`. They cannot check how Chrome draws them, because the test suite cannot drive the Performance panel. The rendering itself is verified only by a manual check the maintainer performs in the repo's playground: open the Performance panel, record, click.
