import { inject, Injectable } from '@angular/core';
import { sensor } from '@mmstack/primitives';

@Injectable({
  providedIn: 'root',
})
export class ResourceSensors {
  readonly networkStatus = sensor('networkStatus');
  readonly pageVisibility = sensor('pageVisibility');
}

export function injectNetworkStatus() {
  return inject(ResourceSensors).networkStatus;
}

export function injectPageVisibility() {
  return inject(ResourceSensors).pageVisibility;
}
