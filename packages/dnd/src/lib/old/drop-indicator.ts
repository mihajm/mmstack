import { DOCUMENT, isPlatformServer } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  Directive,
  ElementRef,
  inject,
  input,
  model,
  PLATFORM_ID,
} from '@angular/core';

import type { Edge } from './types';

const STYLE_ELEMENT_ID = 'mm-drop-indicator-styles';
const EDGE_ATTR = 'data-mm-drop-indicator-edge';

const STYLES = `
[${EDGE_ATTR}]::before {
  content: '';
  position: absolute;
  pointer-events: none;
  background: var(--mm-drop-indicator-color, #2563eb);
  z-index: 1;
}
[${EDGE_ATTR}="top"]::before {
  top: var(--mm-drop-indicator-offset, -1px);
  left: 0;
  right: 0;
  height: var(--mm-drop-indicator-thickness, 2px);
}
[${EDGE_ATTR}="bottom"]::before {
  bottom: var(--mm-drop-indicator-offset, -1px);
  left: 0;
  right: 0;
  height: var(--mm-drop-indicator-thickness, 2px);
}
[${EDGE_ATTR}="left"]::before {
  top: 0;
  bottom: 0;
  left: var(--mm-drop-indicator-offset, -1px);
  width: var(--mm-drop-indicator-thickness, 2px);
}
[${EDGE_ATTR}="right"]::before {
  top: 0;
  bottom: 0;
  right: var(--mm-drop-indicator-offset, -1px);
  width: var(--mm-drop-indicator-thickness, 2px);
}
`.trim();

function ensureStylesInjected(doc: Document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

@Directive({
  selector: '[mmDropIndicator]',
  exportAs: 'mmDropIndicator',
  host: {
    '[attr.data-mm-drop-indicator-edge]': 'activeEdge()',
    '[style.--mm-drop-indicator-thickness.px]': 'thickness()',
    '[style.--mm-drop-indicator-offset]': 'offsetCss()',
  },
})
export class DropIndicator {
  readonly edge = model<Edge | null>(null);
  readonly disabled = model<boolean>(false);
  readonly thickness = input(2);
  readonly gap = input(0);

  protected readonly activeEdge = computed(() =>
    this.disabled() ? null : this.edge(),
  );

  protected readonly offsetCss = computed(
    () => `${-Math.floor(this.thickness() / 2) - this.gap()}px`,
  );

  constructor() {
    if (isPlatformServer(inject(PLATFORM_ID))) return;
    const doc = inject(DOCUMENT);
    ensureStylesInjected(doc);

    const host = inject(ElementRef<HTMLElement>).nativeElement;
    afterNextRender(() => {
      const view = doc.defaultView;
      if (!view) return;
      if (view.getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
    });
  }
}

@Component({
  selector: 'mm-drop-indicator',
  template: '',
  hostDirectives: [
    {
      directive: DropIndicator,
      inputs: ['edge', 'disabled', 'thickness', 'gap'],
    },
  ],
  host: {
    style: 'display: block; position: absolute; inset: 0; pointer-events: none;',
  },
})
export class DropIndicatorComponent {}
