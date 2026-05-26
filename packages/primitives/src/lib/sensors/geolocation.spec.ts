import { TestBed } from '@angular/core/testing';
import { geolocation } from './geolocation';

function stubNavigatorGeolocation(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(navigator, 'geolocation', previous);
    else delete (navigator as any).geolocation;
  };
}

describe('geolocation', () => {
  it('returns a null-valued signal when geolocation API is unavailable', () => {
    const restore = stubNavigatorGeolocation(undefined);

    try {
      TestBed.runInInjectionContext(() => {
        const sig = geolocation();
        expect(sig()).toBeNull();
        expect(sig.error()).toBeNull();
        expect(sig.loading()).toBe(false);
      });
    } finally {
      restore();
    }
  });

  it('populates position from getCurrentPosition', () => {
    const fakePosition = {
      coords: {
        latitude: 1,
        longitude: 2,
        accuracy: 0,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: 0,
    } as unknown as GeolocationPosition;

    const restore = stubNavigatorGeolocation({
      getCurrentPosition: (success: (p: GeolocationPosition) => void) =>
        success(fakePosition),
      watchPosition: () => 0,
      clearWatch: () => undefined,
    });

    try {
      TestBed.runInInjectionContext(() => {
        const sig = geolocation();
        expect(sig()).toBe(fakePosition);
        expect(sig.loading()).toBe(false);
      });
    } finally {
      restore();
    }
  });
});
