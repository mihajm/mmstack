import { Injectable, isDevMode } from '@angular/core';

/**
 * Dev-mode warnings that fire once per call site for the lifetime of the root injector. A
 * call site is a key the caller chooses (a registration's display name), or a specific object
 * when there is none to name it by, so a mistake repeated in thirty places warns thirty times
 * and a widget re-created in a list warns once.
 */
@Injectable({ providedIn: 'root' })
export class ResourceDevWarnings {
  private readonly keys = new Set<string>();
  private readonly targets = new WeakSet<object>();

  warnOnce(key: string, message: string): void {
    if (!isDevMode() || this.keys.has(key)) return;
    this.keys.add(key);
    console.warn(message);
  }

  warnOnceFor(target: object, message: string): void {
    if (!isDevMode() || this.targets.has(target)) return;
    this.targets.add(target);
    console.warn(message);
  }
}
