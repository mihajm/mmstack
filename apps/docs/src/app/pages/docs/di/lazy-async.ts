import { Component } from '@angular/core';
import { CodeExample } from '../../../layout/code-example';
import { DocPage } from '../../../layout/doc-page';
import { DocSection } from '../../../layout/doc-section';

@Component({
  selector: 'docs-di-lazy-async',
  imports: [DocPage, DocSection, CodeExample],
  template: `
    <docs-page
      title="Lazy and async"
      pkg="@mmstack/di"
      lead="Two adjacent problems: deferring when a service is constructed, and deferring when its code is loaded. injectLazy handles the first, injectAsync the second."
    >
      <docs-section title="injectLazy" id="inject-lazy">
        <p>
          <code>inject()</code> resolves and constructs a dependency right away.
          <code>injectLazy</code> captures the injector now but waits to build
          the service until you call the returned getter, then caches it. Good
          for something heavy that only runs on an action, like an export
          routine. It stays synchronous.
        </p>
        <docs-code [code]="lazy" lang="ts" />
        <p>
          It supports Angular's <code>InjectOptions</code>, so
          <code>{{ '{' }} optional: true {{ '}' }}</code> widens the getter to
          <code>T | null</code>.
        </p>
      </docs-section>

      <docs-section title="injectAsync" id="inject-async">
        <p>
          <code>injectAsync</code> loads a service's code chunk through a
          dynamic <code>import()</code> and resolves it from DI on first access,
          returning a memoized getter. The loader runs at most once. Use it to
          keep a bundle out of the initial download until an interaction needs
          it.
        </p>
        <docs-code [code]="async" lang="ts" />
        <p>
          On v22 and up, prefer Angular's built-in <code>injectAsync</code> when
          the service is <code>providedIn: 'root'</code>. This version exists
          for v19 to v21, and for services that are not root-provided: it probes
          normal DI first, and if that misses and the token is a class, it
          auto-provides it in a child injector tied to the target injector.
        </p>
      </docs-section>

      <docs-section title="Prefetching" id="prefetch">
        <p>
          Pass <code>prefetch</code> to warm the chunk ahead of first use:
          <code>'idle'</code>, a millisecond deadline, or a custom trigger. It
          only runs in the browser and is skipped on slow or data-saver
          connections.
        </p>
        <docs-code [code]="prefetch" lang="ts" />
      </docs-section>

      <docs-section title="provideLazy" id="provide-lazy">
        <p>
          <code>provideLazy</code> registers a loader against a token and hands
          back the same <code>[inject, provide, token]</code> tuple. Declare a
          lazy dependency in a route's or component's <code>providers</code>,
          then inject it deep in the tree without that consumer importing the
          module. Every consumer under the provider boundary shares one instance
          and one in-flight load.
        </p>
        <docs-code [code]="provide" lang="ts" />
      </docs-section>
    </docs-page>
  `,
})
export class DiLazyAsync {
  protected readonly lazy = `import { injectLazy } from '@mmstack/di';

private getExportService = injectLazy(HeavyExportService);

export() {
  const service = this.getExportService(); // built on first call, cached after
  service.doExport();
}`;

  protected readonly async = `import { injectAsync } from '@mmstack/di';

private readonly markdown = injectAsync(() =>
  import('./markdown.service').then((m) => m.MarkdownService),
);

async preview(src: string) {
  const svc = await this.markdown(); // loads + resolves once, cached
  return svc.render(src);
}`;

  protected readonly prefetch = `private readonly heavy = injectAsync(
  () => import('./heavy.service').then((m) => m.HeavyService),
  { prefetch: 'idle' },
);`;

  protected readonly provide = `import { provideLazy } from '@mmstack/di';

const [injectMarkdown, provideMarkdown] = provideLazy<MarkdownService>('Markdown');

// register the loader at a route or component boundary
providers: [
  provideMarkdown(() => import('./markdown.service').then((m) => m.MarkdownService)),
];

// consume it below without importing the module
private readonly markdown = injectMarkdown(); // () => Promise<MarkdownService>
async preview(src: string) {
  return (await this.markdown()).render(src);
}`;
}
