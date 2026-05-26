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
});
