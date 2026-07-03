import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { pausableComputed } from '@mmstack/primitives';

@Component({
  selector: 'demo-keep-alive',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <button type="button" (click)="paused.update((p) => !p)">
        {{ paused() ? 'Resume' : 'Pause' }}
      </button>
      <span class="state">boundary: {{ paused() ? 'paused' : 'running' }}</span>
    </div>

    <div class="frames">
      <div class="frame">
        <p class="label">Live frame</p>
        <p class="num">{{ live() }}</p>
        <p class="hint">always tracks the tick</p>
      </div>
      <div class="frame" [class.dim]="paused()">
        <p class="label">Pausable frame</p>
        <p class="num">{{ held() }}</p>
        <p class="hint">
          {{ paused() ? 'frozen, catches up on resume' : 'tracking' }}
        </p>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      max-width: 26rem;
    }

    .bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    button {
      padding: 0.4rem 0.9rem;
      border: 1px solid var(--line, #29292661);
      border-radius: 2px;
      background: var(--fg, #161616);
      color: var(--bg, #faf9f7);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .state {
      font-size: 0.8rem;
      color: var(--fg-muted, #6b7280);
      font-variant-numeric: tabular-nums;
    }

    .frames {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .frame {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
    }

    .frame.dim {
      opacity: 0.55;
    }

    .label {
      margin: 0;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg-muted, #6b7280);
    }

    .num {
      margin: 0.35rem 0;
      font-size: 2.25rem;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }

    .hint {
      margin: 0;
      font-size: 0.75rem;
      color: var(--fg-muted, #6b7280);
      min-height: 1.5em;
    }
  `,
})
export class KeepAliveDemo {
  private readonly tick = signal(0);

  protected readonly paused = signal(false);

  // Reads the same tick, but only while the boundary is running. Paused, it
  // holds its last value and does not recompute, then catches up on resume.
  protected readonly live = computed(() => this.tick());
  protected readonly held = pausableComputed(() => this.tick(), {
    pause: this.paused,
  });

  constructor() {
    const id = setInterval(() => this.tick.update((t) => t + 1), 500);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }
}
