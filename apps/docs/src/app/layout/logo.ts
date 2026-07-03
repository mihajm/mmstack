import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Inline hexagon mark. Stroke is `currentColor`, so it follows the surrounding
 * text color in both themes without any per-theme wiring.
 */
@Component({
  selector: 'docs-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="-10 -10 243 256"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M0 39.192 L84.69 0 L137.387 0 L222.077 39.192 L214.058 165.115 L111.039 235.073 L7.937 165.115 Z"
        stroke="currentColor"
        stroke-width="18"
        stroke-linejoin="round"
      />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      line-height: 0;
    }
  `,
})
export class Logo {
  readonly size = input(24);
}
