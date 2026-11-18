# Mutation testing (Stryker)

Every package in scope has two nx targets:

- `mutate` runs Stryker and prints survivors to the console.
- `mutate-report` runs Stryker and writes reports to `tmp/stryker/<run>/`.

There is one Stryker config, `stryker.config.mjs`, built per project by `config.mjs`. The executor
infers the runner from the project's `test` target. Per-project differences go in the target's options in
`project.json` (`runner`, `exclude`).

```sh
node_modules/.bin/nx run dnd:mutate-report                  # one package, full run
node_modules/.bin/nx run dnd:mutate --mutate=packages/dnd/src/lib/grid/controller.ts   # scoped run
node_modules/.bin/nx run dnd:mutate --mutate=packages/dnd/src/lib/grid/controller.ts:200-400
node_modules/.bin/nx run primitives:mutate-report --tier=logic    # one tier
node_modules/.bin/nx run primitives:mutate --listFiles             # files and tiers, no run
node_modules/.bin/nx run-many -t mutate-report -p di,forms,worker  # several, one after another
```

The targets are never cached and never run in parallel with other tasks (`parallelism: false`), because one
Stryker run already keeps the machine busy.

## Output

`tmp/stryker/<run>/` holds one run. `<run>` is the project name, or `<project>-<tier>` for a tier run,
or whatever `--run=` sets.

| File                          | What it is                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                  | Stryker's HTML report                                                                                                                         |
| `mutation.json`               | the full result in the mutation-testing-report schema                                                                                         |
| `summary.md` / `summary.json` | `mutate-report` only: totals, files ranked by undetected mutants, every survivor and every uncovered mutant with its location and replacement |
| `incremental.json`            | input for `--incremental` reruns                                                                                                              |
| `sandbox/`                    | Stryker's working copy while a run is active, removed after the run                                                                           |

`tmp/stryker/summary.md` is rebuilt after every `mutate-report` and lists one row per run.

## Options

| Option                     | Effect                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--mutate=a.ts,b.ts:10-40` | mutate only these files or line ranges                                       |
| `--tier=logic\|angular`    | mutate only one tier (see below)                                             |
| `--concurrency=N`          | number of Stryker workers, default 4; each worker runs its own Angular build |
| `--incremental`            | reuse earlier results for unchanged code and tests                           |
| `--dryRunOnly`             | instrument and run the suite once, test no mutants                           |
| `--logLevel=trace`         | also prints each worker's Angular build output                               |
| `--run=name`               | output directory name                                                        |
| `--listFiles`              | print the files that would be mutated, with their tier                       |

## Tiers

`angular` is a file that uses Angular beyond signals: decorators, `inject()`, `InjectionToken`,
`Injector`, `DestroyRef`, render hooks, `ElementRef`, `Renderer2`. Every other file is `logic`. The rule
(`ANGULAR_BOUND` in `config.mjs`) is mechanical, so a given file always lands in the same tier.

## How it runs

Two packages (`mesh-protocol`, `translate-tools`) run plain vitest with their own `vite.config.ts` and use
the stock `@stryker-mutator/vitest-runner`.

The others are tested through `@nx/angular:unit-test`. For these, `angular-runner.mjs` is the stock
vitest runner with its startup replaced. It starts the project's `test` target in-process, in watch mode,
with `angular-runner-config.mjs` as the builder's `runnerConfig`. A plugin in that config receives the
Vitest instance the builder creates. From there the stock runner does the rest: dry run, per-test
coverage, one run per mutant. Each Stryker worker does one Angular build, and specs run exactly as they
do under `nx test`.

Things that matter when changing this:

- `vitest.related` is off. Vitest only sees the builder's bundles, so it cannot map specs to `.ts`
  sources. Per-test coverage picks the tests for each mutant instead.
- In watch mode the builder runs the whole suite before handing over. The runner suppresses that first
  run with the builder `filter` option, then removes the filter from Vitest's internal
  `configOverride`. Left in place, that filter would override every later test selection.
- Spec and hook timeouts are 30 s under mutation (instrumentation slows hot property specs well past
  vitest's 5 s default). Stryker's own mutant timeout still catches mutants that never finish.
- The dry run uses most cores. Each mutant run uses one fork per worker.
- `angular-ignorer.mjs` keeps mutants out of code the Angular compiler reads statically: decorator
  metadata, and the option arguments of `input`, `model`, `output`, `outputFromObservable`,
  `viewChild(ren)` and `contentChild(ren)`, and module-level constants those read, in the same file or
  imported from another (a pre-scan finds the imported ones). A mutant in that code breaks the whole
  build (`NG1010`). The
  initial value passed to `input()` and `model()` is still mutated.
- `angular-runner.mjs` imports a file the vitest runner does not export, and touches a Vitest internal.
  It refuses to start unless it finds `@stryker-mutator/vitest-runner` 10.1.1 and vitest 5.x, so a version
  bump means re-checking those two places.
