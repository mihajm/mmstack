import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  signal,
  viewChild,
} from '@angular/core';
import {
  elementSize,
  mediaQuery,
  mousePosition,
  networkStatus,
  pointerDrag,
} from '@mmstack/primitives';

@Component({
  selector: 'demo-sensors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid">
      <div class="cell">
        <p class="label">mediaQuery</p>
        <p class="val">{{ narrow() ? 'narrow' : 'wide' }}</p>
        <p class="hint">
          {{ coarse() ? 'rotate the device' : 'resize the window' }}
        </p>
      </div>

      <div class="cell">
        <p class="label">mousePosition</p>
        <p class="val">{{ round(mouse().x) }}, {{ round(mouse().y) }}</p>
        <p class="hint">
          {{ coarse() ? 'drag a finger across the page' : 'move the pointer' }}
        </p>
      </div>

      <div class="cell">
        <p class="label">networkStatus</p>
        <p class="val">{{ online() ? 'online' : 'offline' }}</p>
        <p class="hint">toggle wifi to see it flip</p>
      </div>

      <div class="cell">
        <p class="label">elementSize</p>
        <p class="val">
          {{ round(size()?.width) }} × {{ round(size()?.height) }}
        </p>
        <div
          #box
          class="resizable"
          [style.width.px]="boxW()"
          [style.height.px]="boxH()"
        >
          drag the corner
          <span #corner class="corner" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
    }

    @media (max-width: 420px) {
      .grid {
        grid-template-columns: minmax(0, 1fr);
      }
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
      position: relative;
      box-sizing: border-box;
      margin-top: 0.5rem;
      max-width: 100%;
      padding: 0.4rem;
      border: 1px dashed var(--line, #29292661);
      border-radius: 6px;
      font-size: 0.72rem;
      color: var(--fg-muted, #6b7280);
    }

    .corner {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 20px;
      height: 20px;
      cursor: nwse-resize;
      touch-action: none;
    }

    .corner::after {
      content: '';
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 8px;
      height: 8px;
      border-right: 2px solid var(--fg-muted, #6b7280);
      border-bottom: 2px solid var(--fg-muted, #6b7280);
    }

    @media (pointer: coarse) {
      .corner {
        width: 36px;
        height: 36px;
      }
    }
  `,
})
export class SensorsDemo {
  private readonly boxRef = viewChild<ElementRef<HTMLElement>>('box');
  private readonly cornerRef = viewChild<ElementRef<HTMLElement>>('corner');

  protected readonly narrow = mediaQuery('(max-width: 640px)');
  protected readonly coarse = mediaQuery('(pointer: coarse)');
  protected readonly mouse = mousePosition({ touch: true });
  protected readonly online = networkStatus();
  protected readonly size = elementSize(
    computed(() => this.boxRef()?.nativeElement ?? null),
  );

  protected readonly boxW = signal(112);
  protected readonly boxH = signal(56);
  private from = { w: 112, h: 56 };

  // A pointer-driven corner instead of CSS resize, which touch browsers ignore:
  // the library's own pointerDrag (primary button only, captured, cancellable).
  protected readonly resize = pointerDrag({
    target: this.cornerRef,
    activationThreshold: 0,
    onChange: (s) => {
      if (!s.active) {
        this.from = { w: this.boxW(), h: this.boxH() };
        return;
      }
      const box = this.boxRef()?.nativeElement;
      const maxW = (box?.parentElement?.clientWidth ?? 432) - 32;
      const clamp = (v: number, lo: number, hi: number) =>
        Math.min(hi, Math.max(lo, v));
      this.boxW.set(clamp(this.from.w + s.delta.x, 64, maxW));
      this.boxH.set(clamp(this.from.h + s.delta.y, 40, 160));
    },
  });

  protected round(n: number | undefined): number {
    return Math.round(n ?? 0);
  }
}
