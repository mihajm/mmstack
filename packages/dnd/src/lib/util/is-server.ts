import { isPlatformServer } from '@angular/common';
import { inject, PLATFORM_ID } from '@angular/core';

export function isServer() {
  return isPlatformServer(inject(PLATFORM_ID));
}
