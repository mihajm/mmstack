import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
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

  function fakeBattery() {
    return Object.assign(new EventTarget(), {
      level: 0.5,
      charging: false,
      chargingTime: Infinity,
      dischargingTime: 3600,
    });
  }
  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  it.each([
    ['chargingchange', 'charging', true],
    ['levelchange', 'level', 0.9],
    ['chargingtimechange', 'chargingTime', 120],
    ['dischargingtimechange', 'dischargingTime', 60],
  ] as const)('updates on %s', async (event, field, value) => {
    const battery = fakeBattery();
    const restore = stubGetBattery(() => Promise.resolve(battery));
    try {
      const sig = TestBed.runInInjectionContext(() => batteryStatus());
      await flush();
      (battery as any)[field] = value;
      battery.dispatchEvent(new Event(event));
      expect(sig()?.[field]).toBe(value);
    } finally {
      restore();
    }
  });

  it('stops updating after destroy', async () => {
    const battery = fakeBattery();
    const restore = stubGetBattery(() => Promise.resolve(battery));
    try {
      const child = createEnvironmentInjector(
        [],
        TestBed.inject(EnvironmentInjector),
      );
      const sig = batteryStatus({ injector: child });
      await flush();
      expect(sig()?.level).toBe(0.5);
      child.destroy();
      battery.level = 0.1;
      battery.dispatchEvent(new Event('levelchange'));
      expect(sig()?.level).toBe(0.5);
    } finally {
      restore();
    }
  });

  it('is null on the server and never asks for the battery', async () => {
    const getBattery = vi.fn(() => Promise.resolve(fakeBattery()));
    const restore = stubGetBattery(getBattery);
    try {
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
      });
      const sig = TestBed.runInInjectionContext(() => batteryStatus());
      await flush();
      expect(sig()).toBeNull();
      expect(getBattery).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
