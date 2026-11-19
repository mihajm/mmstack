import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
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

  type Cb = {
    ok: (p: GeolocationPosition) => void;
    fail: (e: GeolocationPositionError) => void;
  };

  function capturingGeo() {
    const once: Cb[] = [];
    const watchers = new Map<number, Cb>();
    let next = 1;
    const api = {
      getCurrentPosition: vi.fn((ok: Cb['ok'], fail: Cb['fail']) => {
        once.push({ ok, fail });
      }),
      watchPosition: vi.fn((ok: Cb['ok'], fail: Cb['fail']) => {
        const id = next++;
        watchers.set(id, { ok, fail });
        return id;
      }),
      clearWatch: vi.fn((id: number) => watchers.delete(id)),
    };
    return { api, once, watchers };
  }

  const pos = (latitude: number) =>
    ({ coords: { latitude }, timestamp: latitude }) as GeolocationPosition;
  const denied = { code: 1, message: 'denied' } as GeolocationPositionError;

  it('is loading until the first fix arrives', () => {
    const geo = capturingGeo();
    const restore = stubNavigatorGeolocation(geo.api);
    try {
      const sig = TestBed.runInInjectionContext(() => geolocation());
      expect(sig.loading()).toBe(true);
      expect(sig()).toBeNull();
      const p = pos(1);
      geo.once[0].ok(p);
      expect(sig.loading()).toBe(false);
      expect(sig()).toBe(p);
    } finally {
      restore();
    }
  });

  it('surfaces a permission denial as error and stops loading', () => {
    const geo = capturingGeo();
    const restore = stubNavigatorGeolocation(geo.api);
    try {
      const sig = TestBed.runInInjectionContext(() => geolocation());
      geo.once[0].fail(denied);
      expect(sig.error()).toBe(denied);
      expect(sig.loading()).toBe(false);
      expect(sig()).toBeNull();
    } finally {
      restore();
    }
  });

  it('follows every position in watch mode and clears a recovered error', () => {
    const geo = capturingGeo();
    const restore = stubNavigatorGeolocation(geo.api);
    try {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const sig = geolocation({ watch: true, injector: child });
      expect(geo.api.getCurrentPosition).not.toHaveBeenCalled();
      const [watcher] = [...geo.watchers.values()];

      const a = pos(1);
      watcher.ok(a);
      expect(sig()).toBe(a);

      watcher.fail(denied);
      expect(sig.error()).toBe(denied);

      const b = pos(2);
      watcher.ok(b);
      expect(sig()).toBe(b);
      expect(sig.error()).toBeNull();
      child.destroy();
    } finally {
      restore();
    }
  });

  it('stops watching on destroy', () => {
    const geo = capturingGeo();
    const restore = stubNavigatorGeolocation(geo.api);
    try {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const sig = geolocation({ watch: true, injector: child });
      child.destroy();
      for (const w of geo.watchers.values()) w.ok(pos(3));
      expect(sig()).toBeNull();
    } finally {
      restore();
    }
  });

  it('makes no API call on the server', () => {
    const geo = capturingGeo();
    const restore = stubNavigatorGeolocation(geo.api);
    try {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      const sig = TestBed.runInInjectionContext(() =>
        geolocation({ watch: true }),
      );
      const once = TestBed.runInInjectionContext(() => geolocation());
      expect(geo.api.watchPosition).not.toHaveBeenCalled();
      expect(geo.api.getCurrentPosition).not.toHaveBeenCalled();
      expect(sig()).toBeNull();
      expect(once.loading()).toBe(false);
      expect(once.error()).toBeNull();
    } finally {
      restore();
    }
  });
});
