import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  viewChild,
} from '@angular/core';
import {
  elementSize,
  mediaQuery,
  mousePosition,
  networkStatus,
} from '@mmstack/primitives';

@Component({
  selector: 'demo-sensors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid">
      <div class="cell">
        <p class="label">mediaQuery</p>
        <p class="val">{{ narrow() ? 'narrow' : 'wide' }}</p>
        <p class="hint">resize the window</p>
      </div>

      <div class="cell">
        <p class="label">mousePosition</p>
        <p class="val">{{ mouse().x }}, {{ mouse().y }}</p>
        <p class="hint">move the pointer</p>
      </div>

      <div class="cell">
        <p class="label">networkStatus</p>
        <p class="val">{{ online() ? 'online' : 'offline' }}</p>
        <p class="hint">toggle wifi to see it flip</p>
      </div>

      <div class="cell">
        <p class="label">elementSize</p>
        <p class="val">{{ round(size()?.width) }} × {{ round(size()?.height) }}</p>
        <div #box class="resizable">drag the corner ↘</div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 0.75rem;
    }

    .cell {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 0.85rem 1rem;
    }

    .label {
      margin: 0;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      letter-spacing: 0.04em;
      color: var(--fg-muted, #6b7280);
    }

    .val {
      margin: 0.3rem 0 0.15rem;
      font-size: 1.5rem;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }

    .hint {
      margin: 0;
      font-size: 0.72rem;
      color: var(--fg-muted, #6b7280);
    }

    .resizable {
      margin-top: 0.5rem;
      resize: both;
      overflow: auto;
      min-width: 4rem;
      min-height: 2.5rem;
      width: 7rem;
      height: 3.5rem;
      padding: 0.4rem;
      border: 1px dashed var(--line, #29292661);
      border-radius: 6px;
      font-size: 0.72rem;
      color: var(--fg-muted, #6b7280);
    }
  `,
})
export class SensorsDemo {
  private readonly boxRef = viewChild<ElementRef<HTMLElement>>('box');

  protected readonly narrow = mediaQuery('(max-width: 640px)');
  protected readonly mouse = mousePosition();
  protected readonly online = networkStatus();
  protected readonly size = elementSize(
    computed(() => this.boxRef()?.nativeElement ?? null),
  );

  protected round(n: number | undefined): number {
    return Math.round(n ?? 0);
  }
}
