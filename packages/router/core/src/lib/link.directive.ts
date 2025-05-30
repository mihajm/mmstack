import {
  booleanAttribute,
  computed,
  Directive,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import {
  type ActivatedRoute,
  type Params,
  Router,
  RouterLink,
  RouterLinkWithHref,
  UrlTree,
} from '@angular/router';
import { elementVisibility } from '@mmstack/primitives';
import { PreloadService } from './preload.service';

@Directive({
  selector: '[mmLink]',
  exportAs: 'mmLink',
  host: {
    '(mouseenter)': 'onHover()',
  },
  hostDirectives: [
    {
      directive: RouterLink,
      inputs: [
        'routerLink: mmLink',
        'target',
        'queryParams',
        'fragment',
        'queryParamsHandling',
        'state',
        'relativeTo',
        'skipLocationChange',
        'replaceUrl',
      ],
    },
  ],
})
export class LinkDirective {
  private readonly routerLink =
    inject(RouterLink, {
      self: true,
      optional: true,
    }) ?? inject(RouterLinkWithHref, { self: true, optional: true });

  private readonly svc = inject(PreloadService);
  private readonly router = inject(Router);

  readonly target = input<string>();
  readonly queryParams = input<Params>();
  readonly fragment = input<string>();
  readonly queryParamsHandling = input<'merge' | 'preserve' | ''>();
  readonly state = input<Record<string, any>>();
  readonly info = input<unknown>();
  readonly relativeTo = input<ActivatedRoute>();
  readonly skipLocationChange = input(false, { transform: booleanAttribute });
  readonly replaceUrl = input(false, { transform: booleanAttribute });
  readonly mmLink = input.required<string | any[] | UrlTree | null>();
  readonly preloadOn = input<'hover' | 'visible' | null>('hover');

  readonly preloading = output<void>();

  private readonly urlTree = computed(() => {
    const link = this.mmLink();
    const relativeTo = this.relativeTo();
    const fragment = this.fragment();
    const queryParams = this.queryParams();
    const queryParamsHandling = this.queryParamsHandling();

    if (!link) return null;
    const resolvedTree = this.routerLink?.urlTree;
    if (resolvedTree) return resolvedTree;

    if (link instanceof UrlTree) return link;

    const arr = Array.isArray(link) ? link : [link];

    return this.router.createUrlTree(arr, {
      relativeTo,
      queryParams,
      fragment,
      queryParamsHandling,
    });
  });

  private readonly fullPath = computed(() => {
    const urlTree = this.urlTree();
    if (!urlTree) return null;
    return this.router.serializeUrl(urlTree);
  });

  onHover() {
    if (untracked(this.preloadOn) !== 'hover') return;
    this.requestPreload();
  }

  constructor() {
    const intersection = elementVisibility();

    effect(() => {
      if (this.preloadOn() !== 'visible') return;
      if (intersection.visible()) this.requestPreload();
    });
  }

  private requestPreload() {
    const fp = untracked(this.fullPath);
    if (!this.routerLink || !fp) return;
    this.svc.startPreload(fp);
    this.preloading.emit();
  }

  onClick(
    button: number,
    ctrlKey: boolean,
    shiftKey: boolean,
    altKey: boolean,
    metaKey: boolean,
  ) {
    return this.routerLink?.onClick(button, ctrlKey, shiftKey, altKey, metaKey);
  }
}
