import { TestBed } from '@angular/core/testing';
import { batteryStatus } from './battery-status';

function stubGetBattery(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'getBattery');
  Object.defineProperty(navigator, 'getBattery', {
    configurable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(navigator, 'getBattery', previous);
    else delete (navigator as any).getBattery;
  };
}

describe('batteryStatus', () => {
  it('returns null when navigator.getBattery is unavailable', () => {
    const restore = stubGetBattery(undefined);

    try {
      TestBed.runInInjectionContext(() => {
        const sig = batteryStatus();
        expect(sig()).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it('populates the signal once the getBattery promise resolves', async () => {
    const battery = {
      level: 0.75,
      charging: true,
      chargingTime: 1800,
      dischargingTime: Infinity,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };

    const restore = stubGetBattery(() => Promise.resolve(battery));

    try {
      await TestBed.runInInjectionContext(async () => {
        const sig = batteryStatus();
        expect(sig()).toBeNull();

        await Promise.resolve();
        await Promise.resolve();

        expect(sig()).toEqual({
          level: 0.75,
          charging: true,
          chargingTime: 1800,
          dischargingTime: Infinity,
        });
      });
    } finally {
      restore();
    }
  });
});
