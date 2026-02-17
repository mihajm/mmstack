# @mmstack

An ecosystem of reactive, type-safe libraries to supercharge your Angular Signal game. :)

[![CI Status](https://img.shields.io/github/actions/workflow/status/mihajm/mmstack/ci.yml?branch=master&style=flat-square)](https://github.com/mihajm/mmstack/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mihajm/mmstack/blob/master/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

## Vision

Hey, thanks for checking out @mmstack! :) We're building an awesome ecosystem of libraries focused on highly reactive, type-safe, and performant tools, diving deep into areas where standard Angular patterns sometimes leave us wanting more – especially when chasing truly fine-grained reactivity and predictable state. Think advanced async/resource management [@mmstack/resource](https://www.npmjs.com/package/@mmstack/resource), signal forms [@mmstack/form-core](https://www.npmjs.com/package/@mmstack/form-core), powerful signal utilities [@mmstack/primitives](https://www.npmjs.com/package/@mmstack/primitives), a high-performance data grid (in progress...), routing/preload helpers [@mmstack/router-core](https://www.npmjs.com/package/@mmstack/router-core) & more. If that piques your fancy, give some of them a try, & you'll be sure to love 'em.

## Key packages

`@mmstack` provides a suite of libraries to enhance your Angular development experience:

- **[`@mmstack/primitives`](./packages/primitives/README.md):** Foundational utilities and primitives for enhancing Angular Signals (`debounced`, `mutable`, `stored`, `mapArray`, etc.).
- **[`@mmstack/resource`](./packages/resource/README.md):** Powerful, signal-based primitives for managing asynchronous data fetching and mutations (caching, retries, circuit breakers, etc.).
- **[`@mmstack/router-core`](./packages/router/core/README.md):** Enhances Angular Router with signal-based state utilities (`queryParam`, `url`), intelligent module preloading (`Link`, `PreloadStrategy`) & headless breadcrumb utilities (`injectBreadcrumbs`, `createBreadcrumb`).
- **[`@mmstack/form-core`](./packages/form/core/README.md):** Provides the core primitives (`formControl`, `formGroup`, `formArray`) for building flexible, type-safe, signal-based reactive forms.
- **[`@mmstack/form-validation`](./packages/form/validation/README.md):** A composable, type-safe, and localizable validation system designed for `@mmstack/form-core`.
- **[`@mmstack/form-adapters`](./packages/form/adapters/README.md):** Headless, reusable state adapters for common form field types, bridging form logic and UI components.
- **[`@mmstack/form-material`](./packages/form/material/README.md):** A set of Angular Material components that directly consume state adapters from `@mmstack/form-adapters` for easy form building.
- **[`@mmstack/translate`](./packages/translate/README.md):** A modular & type safe solution to localization.
- **[`@mmstack/local`](./packages/local/README.md):** Local data management helpers, starting with a reactive, type-safe IndexedDB wrapper for managing local client-side storage with optimistic updates and cross-tab syncing.

## Versioning

The major version of @mmstack libraries (e.g., v19.x.x, v20.x.x) aligns with the major version of Angular they are designed for. This ensures clear compatibility.

Within a major version, minor and patch versions follow Semantic Versioning (SemVer):

- Minor versions (X.y.0) introduce new, non-breaking features.
- Patch versions (X.Y.z) provide backwards-compatible bug fixes.

Bugfixes are guaranteed for 1 major version back (maybe more in the future, but that's all I can promise for now :) )

## Contributing

Contributions are welcome and greatly appreciated! Please see our [Contributing Guidelines](CONTRIBUTING.md) to learn how you can get involved with the `@mmstack` project.

## Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for all. Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

This project is licensed under the terms of the MIT License. See the [LICENSE](LICENSE) file for the full license text.
