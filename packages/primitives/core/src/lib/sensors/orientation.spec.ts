import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { orientation } from './orientation';

function stubScreenOrientation(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(screen, 'orientation');
  Object.defineProperty(screen, 'orientation', {
    configurable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(screen, 'orientation', previous);
    else delete (screen as any).orientation;
  };
}

describe('orientation', () => {
  it('falls back to portrait-primary when screen.orientation is missing', () => {
    const restore = stubScreenOrientation(undefined);

    try {
      TestBed.runInInjectionContext(() => {
        const sig = orientation();
        expect(sig()).toEqual({ angle: 0, type: 'portrait-primary' });
      });
    } finally {
      restore();
    }
  });

  it('reads angle and type from screen.orientation when available', () => {
    const listeners = new Map<string, EventListener>();
    const restore = stubScreenOrientation({
      angle: 90,
      type: 'landscape-primary' as OrientationType,
      addEventListener: (name: string, fn: EventListener) =>
        listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    });

    try {
      TestBed.runInInjectionContext(() => {
        const sig = orientation();
        expect(sig()).toEqual({ angle: 90, type: 'landscape-primary' });
      });
    } finally {
      restore();
    }
  });

  function fakeOrientation() {
    return Object.assign(new EventTarget(), {
      angle: 0,
      type: 'portrait-primary' as OrientationType,
    });
  }

  it('follows change events', () => {
    const so = fakeOrientation();
    const restore = stubScreenOrientation(so);
    try {
      const sig = TestBed.runInInjectionContext(() => orientation());
      Object.assign(so, { angle: 90, type: 'landscape-primary' });
      so.dispatchEvent(new Event('change'));
      expect(sig()).toEqual({ angle: 90, type: 'landscape-primary' });
    } finally {
      restore();
    }
  });

  it('stops following after destroy', () => {
    const so = fakeOrientation();
    const restore = stubScreenOrientation(so);
    try {
      const injector = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const sig = orientation({ injector });
      injector.destroy();
      Object.assign(so, { angle: 90, type: 'landscape-primary' });
      so.dispatchEvent(new Event('change'));
      expect(sig()).toEqual({ angle: 0, type: 'portrait-primary' });
    } finally {
      restore();
    }
  });

  it('is portrait-primary on the server, whatever the screen says', () => {
    const so = Object.assign(fakeOrientation(), {
      angle: 90,
      type: 'landscape-primary' as OrientationType,
    });
    const restore = stubScreenOrientation(so);
    try {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      const sig = TestBed.runInInjectionContext(() => orientation());
      expect(sig()).toEqual({ angle: 0, type: 'portrait-primary' });
    } finally {
      restore();
    }
  });
});
