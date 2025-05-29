import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PreloadService {
  private readonly preloadOnDemand$ = new Subject<string>();
  readonly preloadRequested$ = this.preloadOnDemand$.asObservable();

  startPreload(routePath: string) {
    this.preloadOnDemand$.next(routePath);
  }
}
