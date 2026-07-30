# Contributing

@mmstack is an MIT-licensed open source project with its ongoing development made by contributors.

## Overview

### Folder structure

Source code for various libraries exist under the `packages/` folder. To contribute features/bug fixes, locate the relevant code in one of the `packages`. To help find the library you're looking for, you can check the [tsconfig.base.json](https://github.com/mihajm/mmstack/blob/master/tsconfig.base.json), which contains paths to every library.

### Setup

@mmstack uses [pnpm](https://pnpm.io/) to manage its dependencies.

Before opening a pull request, run the following command to make sure your dependencies are up to date:

```bash
pnpm i
```

Please also make sure you run lint & test commands on libraries your PR modifies before pushing:

```bash
pnpm nx lint form-core
pnpm nx test form-core
```

## Running locally

You can use the _docs_ or _playground_ applications to test out stuff you're working on. To run one use

```bash
pnpm nx serve docs
```

or serve both (docs on port 4200, playground on 4201):

```bash
pnpm start
```

### Build

@mmstack uses NX to manage its libraries, you can build a specific library by using its name like so:

```bash
pnpm nx build form-core
```

or build them all:

```bash
pnpm nx run-many --target=build
```

## Submitting pull requests

Please follow the steps below to simplify pull request reviews:

- Merge your branch with the latest `master` branch
- Run lint/tests before submitting
- Make references to `issues`, if relevant
- Ensure that your PR only fixes/adds one thing. While PR's can have multiple commits, please ensure that each PR is focused on one feature or bug fix

### Commit message guidelines

@mmstack follows the conventional commits spec for its commit messages, here are a few examples:

```
feat(form-adapters): Added date range adapter
fix(form-core): Fixed reconciliation of form-array child controls
```

The types we use are:

- infra: Dependency updates, folder structure changes, scripts etc.
- docs: Documentation only changes
- feat: A new feature
- fix: A bug fix
- refactor: A code change that neither fixes a bug nor adds a feature
- chore: Used for ci/cd pipeline actions

The scopes we use are simply the name of the library your change affects, currently these are:

- primitives
- resource
- local
- forms
- form-core
- form-adapters
- form-validation
- form-material
- router-core
- di
- dnd
- worker
- mesh
- mesh-protocol
- translate
- translate-tools
- telemetry-core
- telemetry-otel
- telemetry-posthog
- telemetry-sentry

## Submitting bug reports

Please search through existing issues that have been reported before submitting a new bug report. If you find a related & open issue, just add a comment to it :) Please be as detailed as possible about library versions, environment & other variables when submitting a bug report. If possible a Stackblitz project or github repository is welcome.

[open a new one](https://github.com/mihajm/mmstack/issues/new?template=bug_report.yml)

## Submitting new feature requests

If you have a cool new idea, or a requirement the current libraries dont fulfill, please don't hesitate to either make a feature request or an RFC. Please prefix such issues with either `Feature:` or `RFC:` & we'll try to respond ASAP. :)

[make a feature request or an RFC](https://github.com/mihajm/mmstack/issues/new?template=feature_request.yml)
