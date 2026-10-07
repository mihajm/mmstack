import { Component, output } from '@angular/core';

// The small Reset row the drag and drop demos share, so a visitor can always get the
// starting layout back without reloading the page.
@Component({
  selector: 'demo-reset',
  template: `<button type="button" (click)="restore.emit()">Reset</button>`,
  styles: `
    :host {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 0.5rem;
    }

    button {
      position: relative;
      padding: 0.15rem 0.6rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      background: transparent;
      color: var(--fg-muted, #6b7280);
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
    }

    button:hover {
      color: var(--fg, #111827);
      border-color: var(--fg-muted, #6b7280);
    }

    @media (pointer: coarse) {
      :host {
        margin-bottom: 0.75rem;
      }

      button::after {
        content: '';
        position: absolute;
        inset: -11px -8px;
      }
    }
  `,
})
export class DemoReset {
  readonly restore = output<void>();
}
