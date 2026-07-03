import { Component } from '@angular/core';
import { Link } from '@mmstack/router-core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-translate-tooling',
  imports: [DocPage, DocSection, CodeExample, Link],
  template: `
    <docs-page
      title="Tooling"
      pkg="@mmstack/translate-tools"
      lead="A standalone CLI that round-trips your TypeScript namespaces through JSON, so a translation team can work in the format they know while you keep authoring in TypeScript. It also checks translations against the source shape, which makes a clean CI gate."
    >
      <docs-code [code]="install" lang="bash" />
      <p>
        Authoring in TypeScript is what buys the compile-time safety, but a
        translator does not want a <code>.ts</code> file, and a TMS platform
        cannot ingest one. This tool bridges that: it exports your
        <em>translations</em> to plain JSON, and imports the translated JSON
        back as generated
        <a mmLink="/docs/translate/namespaces"><code>createTranslation</code></a>
        modules, wiring each new locale into its
        <code>registerNamespace</code> call for you. Your source
        <code>createNamespace</code> is never touched.
      </p>
      <p>
        It reads that source statically. It never runs your code and never
        imports <code>&#64;mmstack/translate</code>, so one version of the tool
        works across releases (it is versioned independently, starting at
        <code>1.x</code>, and runs in an Nx monorepo or a plain
        <code>ng new</code> app).
      </p>

      <docs-section title="The round-trip" id="round-trip">
        <p>
          Three commands, in order. <code>export</code> writes one nested JSON
          file per namespace per locale, keys mirroring your
          <code>createNamespace</code> tree with ICU messages preserved verbatim.
          A translator or TMS edits those. <code>import</code> reads them back,
          generates a <code>createTranslation</code> module per new locale next
          to the source namespace, and inserts the loader into the matching
          registry.
        </p>
        <docs-code [code]="workflow" lang="bash" />
        <p>
          Export also drops a small hidden
          <code>.mmtranslate-meta.json</code> recording the source locale, so a
          later <code>import</code> knows which locale is the source without you
          repeating <code>--source-locale</code>. A new locale's file is created
          only if one is not already there; pass <code>--force</code> to
          overwrite. An existing locale is updated in place.
        </p>
      </docs-section>

      <docs-section title="What import validates" id="checking">
        <p>
          Before writing anything, <code>import</code> checks each non-source
          file against the source locale. Every leaf must be valid ICU and use
          the same placeholders as the source, so a dropped or renamed
          <code>{{ '{' }} name {{ '}' }}</code> is reported. It must cover every
          source key, so a missing translation is reported. And it must contain
          no unknown keys, because <code>createTranslation</code> is typed to the
          source shape and an extra key would generate code that does not
          compile, so the tool rejects the file rather than write it.
        </p>
        <p>
          Rejection is per file, so one bad file never blocks the rest of the
          run. Files the run does not recognize (a typo'd namespace, a stray-dot
          name) are reported as <strong>skipped</strong> with a reason, so a
          mis-named file cannot silently vanish.
        </p>
      </docs-section>

      <docs-section title="Hygiene rules for CI" id="ci">
        <p>
          <code>lint</code> runs the hygiene rules in one discovery pass with a
          merged report and a single non-zero exit code, which is what a CI job
          or a pre-commit hook wants. <code>dupes</code> reports the same
          normalized source value under different keys (add
          <code>--ignore-case</code> to fold case), grouped by value with every
          key path. <code>unused</code> reports keys no scanned app source
          references.
        </p>
        <docs-code [code]="lint" lang="bash" />
        <p>
          <code>unused</code> is deliberately conservative. A typed
          <code>t('x.y.z')</code> access counts as usage, but anything reached
          dynamically (a computed access, or a subtree passed around whole) is
          treated as unknown rather than unused, so the rule only reports keys
          it can prove are dead. This pairs with the typed API: dynamic keys are
          untypeable by design, which is the same property that keeps
          <code>unused</code> honest.
        </p>
        <p>
          Silence a finding with a comment in the translation module, the same
          principle as eslint (rule names <code>duplicate</code> and
          <code>unused</code>; omit the name to disable all rules). Markers are
          located with the TypeScript scanner, so one written inside a
          translation string never suppresses anything.
        </p>
        <docs-code [code]="suppress" lang="ts" />
      </docs-section>

      <docs-section title="Pinning discovery" id="manifest">
        <p>
          Discovery is automatic: the tool walks your source globs and resolves
          each <code>registerNamespace</code> to the namespace it points at. When
          you would rather pin that list than rely on the glob, or the glob is
          not catching something, <code>generate-manifest</code> writes an
          <code>mmtranslate.config.ts</code> naming the discovered namespaces,
          their registry files, and locales. It is a starting point you hand-edit
          and commit.
        </p>
        <docs-code [code]="manifest" lang="bash" />
        <p>
          The engine is also exported for scripting
          (<code>discoverFromProject</code>, <code>planExport</code>,
          <code>runImport</code>, and the rest), so you can drive the round-trip
          from your own tooling instead of the CLI.
        </p>
      </docs-section>
    </docs-page>
  `,
})
export class ToolingDoc {
  protected readonly install = 'npm i -D @mmstack/translate-tools';

  protected readonly workflow = `# 1. hand off source strings to translators / your TMS
npx mmtranslate export --src "src/**/*.ts" --out i18n

# 2. ...they translate i18n/<namespace>.<locale>.json...

# 3. bring the translations back as generated TypeScript
npx mmtranslate import --src "src/**/*.ts" --in i18n`;

  protected readonly lint = `# runs dupes + unused in one pass, single exit code for CI
npx mmtranslate lint --src "src/**/*.ts" --report json

# individual rules
npx mmtranslate dupes  --src "src/**/*.ts" --ignore-case
npx mmtranslate unused --src "libs/i18n/**/*.ts" --app-src "src/**/*.ts"`;

  protected readonly manifest = `# write a config pinning discovered namespaces, registries, and locales
npx mmtranslate generate-manifest --src "src/**/*.ts" --out mmtranslate.config.ts`;

  protected readonly suppress = `/* mmtranslate-disable duplicate */ // before the first statement, whole file

export const common = createNamespace('common', {
  save: 'Save',
  // mmtranslate-disable-next-line duplicate
  confirm: 'Save', // just this key
});`;
}
