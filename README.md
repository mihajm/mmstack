# @mmstack

An ecosystem of reactive, type-safe libraries to supercharge your Angular Signal game. :)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

📖 **Docs & live demos: [mihajm.github.io/mmstack](https://mihajm.github.io/mmstack)**

## Vision

Hey, thanks for checking out @mmstack! :) We're building an ecosystem of libraries focused on highly reactive, type-safe, and performant tools, diving deep into areas where standard Angular patterns sometimes leave us wanting more, especially when chasing truly fine-grained reactivity and predictable state. Think advanced async/resource management [@mmstack/resource](https://www.npmjs.com/package/@mmstack/resource), deep signal stores & concurrency primitives [@mmstack/primitives](https://www.npmjs.com/package/@mmstack/primitives), route-level transitions & preloading [@mmstack/router-core](https://www.npmjs.com/package/@mmstack/router-core), off-thread state [@mmstack/worker](https://www.npmjs.com/package/@mmstack/worker), multiplayer sync [@mmstack/mesh](https://www.npmjs.com/package/@mmstack/mesh) & more. If that piques your fancy, give some of them a try, & you'll be sure to love 'em.

## Key packages

`@mmstack` provides a suite of libraries to enhance your Angular development experience:

- **[`@mmstack/primitives`](./packages/primitives/README.md):** Signal utilities useful for any app; from simple sensors to deep stores, concurrency & suspense primitives, persistence and cross-tab sync.
- **[`@mmstack/resource`](./packages/resource/README.md):** Data fetching with caching, retries, circuit breakers & much more. Built on Angular resources & signals.
- **[`@mmstack/router-core`](./packages/router/core/README.md):** Transitions, preloading, data-fetching & breadcrumbs, all declarative at the route level.
- **[`@mmstack/forms`](./packages/forms/README.md):** Utilities for Angular Signal Forms, starting with field metadata & change tracking.
- **[`@mmstack/dnd`](./packages/dnd/README.md):** Fine-grained reactive drag and drop.
- **[`@mmstack/translate`](./packages/translate/README.md):** Feature-level i18n. Type-safe & fully reactive.
- **[`@mmstack/di`](./packages/di/README.md):** Dependency injection utilities like `injectable`, `injectAsync` & `provideLazy`.
- **[`@mmstack/worker`](./packages/worker/README.md)** (experimental)**:** Off-thread state & compute. A worker owns state, the UI reads a live replica.
- **[`@mmstack/telemetry-core`](./packages/telemetry/core/README.md)** (experimental)**:** Signals-native telemetry with explicit, zone-free context. Spans, events, errors, metrics & logs, with adapters for OTLP ([-otel](./packages/telemetry/otel/README.md)), PostHog ([-posthog](./packages/telemetry/posthog/README.md)) & Sentry ([-sentry](./packages/telemetry/sentry/README.md)).
- **[`@mmstack/mesh`](./packages/mesh/client/README.md)** (experimental)**:** Multiplayer for signal stores. Sync a store across tabs, a worker, a relay or peers; it reads exactly like a local store. Pairs with [`@mmstack/mesh-protocol`](./packages/mesh/protocol/README.md), a zero-dependency relay you can run anywhere.

Packages marked experimental are released and usable today, but their APIs may still shift between minor versions while we dogfood them.

## Versioning

The major version of @mmstack libraries (e.g., v21.x.x, v22.x.x) aligns with the major version of Angular they are designed for. This ensures clear compatibility.

Within a major version, minor and patch versions follow Semantic Versioning (SemVer):

- Minor versions (X.y.0) introduce new, non-breaking features.
- Patch versions (X.Y.z) provide backwards-compatible bug fixes.

The exceptions are `@mmstack/translate-tools` & `@mmstack/mesh-protocol`, which are framework-agnostic and versioned independently - normal semver applies.

Bugfixes are guaranteed for 1 major version back, though most new features/fixes have been backported already to v20.

## Contributing

Contributions are welcome and greatly appreciated! Please see our [Contributing Guidelines](CONTRIBUTING.md) to learn how you can get involved with the `@mmstack` project.

## Contributors

Thanks to everyone who has pitched in! :)

<a href="https://github.com/mihajm/mmstack/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=mihajm/mmstack" alt="mmstack contributors" />
</a>

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for all. Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

This project is licensed under the terms of the MIT License. See the [LICENSE](LICENSE) file for the full license text.
