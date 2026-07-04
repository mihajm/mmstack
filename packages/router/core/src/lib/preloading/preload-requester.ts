import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** `'code'` warms route code only; `'all'` also warms route data. */
export type PreloadScope = 'all' | 'code';

export type PreloadRequest = {
  readonly path: string;
  readonly scope: PreloadScope;
};

@Injectable({ providedIn: 'root' })
export class PreloadRequester {
  private readonly preloadOnDemand$ = new Subject<PreloadRequest>();
  readonly preloadRequested$ = this.preloadOnDemand$.asObservable();

  startPreload(routePath: string, scope: PreloadScope = 'all') {
    this.preloadOnDemand$.next({ path: routePath, scope });
  }
}
