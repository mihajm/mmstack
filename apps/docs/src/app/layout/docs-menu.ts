import { Injectable, signal } from '@angular/core';

/**
 * Open/closed state for the mobile docs drawer. Shared so the toggle in the
 * global header (app.ts) and the drawer itself (docs-shell.ts) stay in sync.
 * Defaults closed, so prerendered pages ship with the drawer hidden.
 */
@Injectable({ providedIn: 'root' })
export class DocsMenu {
  readonly open = signal(false);

  toggle(): void {
    this.open.update((v) => !v);
  }

  close(): void {
    this.open.set(false);
  }
}
