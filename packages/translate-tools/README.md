# @mmstack/translate-tools

Build-time tooling for [`@mmstack/translate`](https://www.npmjs.com/package/@mmstack/translate): export your TypeScript-authored
namespaces to JSON for translators / TMS platforms, then import the translations back as generated
`createTranslation` modules.

Authoring stays TypeScript-first, you keep writing `createNamespace({ ... })`. This tool just round-trips the **translations** through plain JSON files and writes the per-locale TypeScript for you, wiring each new locale into its `registerNamespace` registry. Allowing for easier co-working with translation teams or sharing between projects.

It's a standalone CLI (+ a programmatic API), works in an Nx monorepo or a plain `ng new` app.

## Install

```bash
npm i -D @mmstack/translate-tools
# or: pnpm add -D @mmstack/translate-tools
```

## Compatibility

This package is **versioned independently** (starting at `1.x`) rather than tracking Angular like the
other `@mmstack/*` libraries. it's a Node tool that knows mmstack's _authoring patterns_, not
Angular. It **never imports `@mmstack/translate`**; it statically reads your `createNamespace` /
`registerNamespace` / `createTranslation` source, so a single version works across all current
`@mmstack/translate` releases (v19+). A version-compatibility table will be added here only if the
authoring API ever diverges.

## The workflow

```bash
# 1. Hand off source strings to translators / your TMS
npx mmtranslate export --src "src/**/*.ts" --out i18n

# 2. ...they translate i18n/<namespace>.<locale>.json...

# 3. Bring the translations back as generated TypeScript
npx mmtranslate import --src "src/**/*.ts" --in i18n
```

## Commands

### `export`

Writes one **nested** JSON file per namespace per locale `<namespace>.<locale>.json` for the
source locale and every registered target locale. Keys mirror your `createNamespace` tree; ICU
messages are preserved verbatim.

```bash
npx mmtranslate export --src "src/**/*.ts" --out i18n --source-locale en
```

```jsonc
// i18n/quote.en.json
{
  "title": "Quotes",
  "detail": { "authorLabel": "Author" },
}
```

It also writes a small hidden `.mmtranslate-meta.json` recording the source locale, so a later `import` knows which locale is the source even without `--source-locale`. It's not a translation file translators/TMS platforms can ignore it.

### `import`

For each `<namespace>.<locale>.json` that isn't the source locale, it:

- **validates** every leaf is valid ICU, uses the **same placeholders** as the source (a dropped or
  renamed `{name}` is reported), **covers every source key** (a missing key is reported), and
  **contains no unknown keys** (an extra key would generate TypeScript that doesn't compile —
  `createTranslation` is typed to the source shape). A file with any issue is rejected so nothing
  "malformed" is written — always **per file**, so one bad file never blocks the rest of the run;
- for a **new** locale, generates `<namespace>.<locale>.ts` (a `createTranslation` call) next to the
  source namespace and inserts its loader into the matching `registerNamespace(...)` call. If a file
  already exists at that path the locale is **rejected** unless you pass `--force`;
- for an **existing** locale, updates that module's translation in place.

`.json` files the run doesn't recognize — a typo'd namespace, a stray-dot name — are reported as
**skipped** with a reason, so a mis-named file can't silently vanish from a run.

`import` reads the source locale from the sidecar `export` wrote, so `--source-locale` only needs to
be repeated if you're importing files that weren't produced by this tool.

The source `createNamespace` is never regenerated.

```bash
npx mmtranslate import --src "src/**/*.ts" --in i18n --source-locale en
```

### `generate-manifest`

Writes a config listing the discovered namespaces, their registry files, and locales. It's a starting point you can hand-edit if you'd rather pin discovery than rely on the automatic glob, or if that's not grabbing things correctly for some reason.

```bash
npx mmtranslate generate-manifest --src "src/**/*.ts" --out mmtranslate.config.ts
```

### `dupes` / `unused` / `lint`

Hygiene rules over the discovered namespaces. `dupes` reports the same normalized source-locale value under different keys (trim + collapsed whitespace; `--ignore-case` to fold case), within and across namespaces — grouped by value with every key path and file location. `unused` reports keys no scanned app source references: the typed `t.x.y.z` access pattern (and the dotted string `'x.y.z'`) counts as usage, and anything reached dynamically — a computed access like `t.detail[key]`, or a subtree passed around whole — is conservatively skipped as **unknown, not unused**, so the rule only reports what it can prove. `lint` runs every rule in one discovery pass with a merged report and a single non-zero exit code for CI.

```bash
npx mmtranslate dupes  --src "src/**/*.ts" --ignore-case
npx mmtranslate unused --src "libs/i18n/**/*.ts" --app-src "src/**/*.ts"
npx mmtranslate lint   --src "src/**/*.ts" --report json
```

Suppress findings with comments in the translation module, same principle as eslint (rule names `duplicate` and `unused`; no names = all rules):

```ts
/* mmtranslate-disable duplicate */        // before the first statement — whole file

export const common = createNamespace('common', {
  save: 'Save',
  // mmtranslate-disable-next-line duplicate
  confirm: 'Save',                         // just this key
});
```

Comments are located with the TypeScript scanner, so a marker inside a translation *string* never suppresses anything. Suppressed keys leave their duplicate group before the ≥2 check — suppressing all but one member silences the group.

### Options

| Flag                       | Applies to                 | Default                                     | Meaning                                                                |
| -------------------------- | -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `--src <glob>`             | all (repeatable)           | `src/**/*.ts`                               | Source files to scan.                                                  |
| `--out <dir\|file>`        | export / generate-manifest | `translations` / `mmtranslate.config.ts`    | Output dir (export) or manifest file.                                  |
| `--in <dir>`               | import                     | `translations`                              | Directory of translated JSON.                                          |
| `--source-locale <locale>` | all                        | `en` (import: the value recorded at export) | Label for the default/source translation (your app's `defaultLocale`). |
| `--force`                  | import                     | off                                         | Overwrite an existing file when adding a new locale.                   |
| `--ignore-case`            | dupes / lint               | off                                         | Compare values case-insensitively.                                     |
| `--app-src <glob>`         | unused / lint (repeatable) | the `--src` globs                           | App sources for the usage scan (definition/registry files never count). |
| `--report json`            | dupes / unused / lint      | human output                                | Machine-readable report.                                               |

## How discovery works

The tool statically reads your `registerNamespace(default, { locale: loader })` calls, these are
the per-namespace registries and resolves each loader to the `createNamespace`,
`createMergedNamespace`, or `createTranslation` call it points at, lifting the translation object
directly from source. No code runs.

- **`withParams(...)`** is handled transparently: it's exported as its full ICU string, and target
  locales are emitted as plain strings (they never need to repeat the wrapper).
- **Merged namespaces** (`common.createMergedNamespace('quote', ...)`) export only their own keys —
  the shared/common namespace is its own file, with no duplication.
- **`registerRemoteNamespace`** or any imperative additions to translations are skipped.

## Programmatic API

The engine is exported too, if you'd rather script it:

```ts
import { Project } from 'ts-morph';
import {
  discoverFromProject,
  planExport,
  runImport,
} from '@mmstack/translate-tools';
```

`runExport` / `runImport` / `runGenerateManifest` (fs-performing), plus the building blocks:
`discoverFromProject`, `planExport`, `validateImport`, `applyImport`, and the lower-level
`lift` / `codegen` / `registry` / `nested` / `icu` helpers.

## Supported source shapes

For a namespace to be discovered and round-tripped:

- Loaders use a static dynamic `import('./path')`. Every form `@mmstack/translate` accepts at
  runtime is supported: `.then((m) => m.quote.translation)`, `.then((m) => m.default)`, and the
  `() => import('./path')` shorthand (which auto-resolves the module's `default` or `translation`
  export). Async/`await` or computed-access loaders are skipped with a warning.
- Translation values are string literals, template literals (no substitutions),
  `withParams('literal')`, or nested objects. Dynamic values (a variable, a concatenation) are
  rejected with a clear error — inline a literal so the tool can round-trip it.
- A namespace name contains no `.` (it's the first segment of the export file name).
