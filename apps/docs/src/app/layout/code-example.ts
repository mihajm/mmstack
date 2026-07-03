import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  PLATFORM_ID,
  signal,
  untracked,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

type Lang = 'ts' | 'html' | 'bash' | 'json';

// Fine-grained highlighter: only the languages the docs use, so the build
// doesn't drag in every grammar shiki ships. angular templates render as html.
let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/json.mjs'),
    ],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
  return highlighter;
}

const LANG_ID: Record<Lang, string> = {
  ts: 'typescript',
  html: 'html',
  bash: 'bash',
  json: 'json',
};

// Prerendered output ships the plain <pre>; shiki enhances client-side only,
// so the highlighter never runs during SSG and loads off the critical path.
// The dark palette is swapped by styles.css via [data-theme].
async function highlight(code: string, lang: Lang): Promise<string> {
  const h = await getHighlighter();
  return h.codeToHtml(code, {
    lang: LANG_ID[lang],
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: 'light',
  });
}

@Component({
  selector: 'docs-code',
  template: `
    <figure [class.labeled]="!!label()">
      @if (label()) {
        <figcaption>{{ label() }}</figcaption>
      }
      <div class="code-wrap">
        @if (highlighted(); as html) {
          <div class="highlighted" [innerHTML]="html"></div>
        } @else {
          <pre><code>{{ trimmed() }}</code></pre>
        }
        @if (canCopy) {
          <button
            type="button"
            class="copy"
            (click)="copy()"
            [attr.aria-label]="copied() ? 'Copied' : 'Copy code'"
          >
            {{ copied() ? 'copied' : 'copy' }}
          </button>
        }
      </div>
    </figure>
  `,
  styles: `
    figure {
      margin: 1rem 0;
    }

    figcaption {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--fg-muted);
      background: var(--bg-soft);
      border: 1px solid var(--line);
      border-bottom: none;
      border-radius: 2px 2px 0 0;
      padding: 0.4rem 1rem;
    }

    .code-wrap {
      position: relative;
    }

    .labeled .highlighted ::ng-deep pre,
    .labeled pre {
      border-radius: 0 0 2px 2px;
    }

    .highlighted ::ng-deep pre {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      line-height: 1.55;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 0.9rem 1rem;
      margin: 0;
      tab-size: 2;
    }

    .copy {
      position: absolute;
      top: 0.4rem;
      right: 0.4rem;
      font-family: var(--font-mono);
      font-size: 0.68rem;
      line-height: 1;
      padding: 0.3rem 0.45rem;
      color: var(--fg-muted);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 2px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 100ms;
    }

    .code-wrap:hover .copy,
    .copy:focus-visible {
      opacity: 1;
    }

    .copy:hover {
      color: var(--fg);
    }
  `,
})
export class CodeExample {
  readonly code = input.required<string>();
  readonly lang = input<Lang>('ts');
  /** Optional caption, e.g. a file name. */
  readonly label = input<string>();

  protected readonly trimmed = computed(() => this.code().trim());
  protected readonly highlighted = signal<SafeHtml | null>(null);
  protected readonly copied = signal(false);

  private readonly sanitizer = inject(DomSanitizer);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly canCopy =
    this.isBrowser && typeof navigator !== 'undefined' && !!navigator.clipboard;

  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.resetTimer) clearTimeout(this.resetTimer);
    });

    if (!this.isBrowser) return;

    effect(() => {
      const code = this.trimmed();
      const lang = this.lang();
      highlight(code, lang).then((html) => {
        // Stale-guard: only apply if inputs haven't changed since kickoff.
        if (untracked(this.trimmed) !== code || untracked(this.lang) !== lang)
          return;
        // Safe: content is authored in this repo, and shiki's inline styles
        // would otherwise be stripped by the sanitizer.
        this.highlighted.set(this.sanitizer.bypassSecurityTrustHtml(html));
      });
    });
  }

  protected copy(): void {
    navigator.clipboard.writeText(this.trimmed()).then(() => {
      this.copied.set(true);
      if (this.resetTimer) clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
