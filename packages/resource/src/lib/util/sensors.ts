import { inject, Injectable } from '@angular/core';
import { sensor } from '@mmstack/primitives';

@Injectable({
  providedIn: 'root',
})
export class ResourceSensors {
  readonly networkStatus = sensor('networkStatus');
}

export function injectNetworkStatus() {
  return inject(ResourceSensors).networkStatus;
}
