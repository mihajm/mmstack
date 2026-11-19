import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { cdp, page, server, userEvent } from 'vitest/browser';
import { clipboard } from './clipboard';
import { geolocation } from './geolocation';
import { mediaQuery, prefersDarkMode } from './media-query';
import { orientation } from './orientation';
import { scrollPosition } from './scroll-position';
import { windowSize } from './window-size';

type Cdp = { send(method: string, params?: object): Promise<unknown> };
const chromium = server.browser === 'chromium';
const session = () => cdp() as unknown as Cdp;
const injector = () => TestBed.inject(Injector);

// Browser-domain calls must name Playwright's browser context, not the default one
async function permissions(method: string, params: object = {}) {
  const info = (await session().send('Target.getTargetInfo')) as {
    targetInfo: { browserContextId: string };
  };
  return session().send(method, {
    ...params,
    origin: location.origin,
    browserContextId: info.targetInfo.browserContextId,
  });
}

async function settle(ms = 20) {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, ms));
  TestBed.tick();
}

async function until(check: () => boolean, tries = 100) {
  for (let i = 0; i < tries && !check(); i++) await settle(10);
}

afterEach(() => {
  document.body.replaceChildren();
  window.scrollTo(0, 0);
});

describe('scrollPosition, windowSize and orientation', () => {
  it('reports a single-axis window scroll', async () => {
    const filler = document.createElement('div');
    filler.setAttribute('style', 'width: 4000px; height: 4000px');
    document.body.appendChild(filler);
    const pos = scrollPosition({ throttle: 0, injector: injector() });

    window.scrollTo(0, 300);
    await until(() => pos.unthrottled().y === 300);
    expect(pos.unthrottled()).toEqual({ x: 0, y: 300 });

    window.scrollTo(200, 300);
    await until(() => pos.unthrottled().x === 200);
    expect(pos.unthrottled()).toEqual({ x: 200, y: 300 });
  });

  it('follows a width-only and then a height-only viewport change', async () => {
    await page.viewport(800, 600);
    await settle();
    const size = windowSize({ throttle: 0, injector: injector() });
    expect(size.unthrottled()).toEqual({ width: 800, height: 600 });

    await page.viewport(640, 600);
    await until(() => size.unthrottled().width === 640);
    expect(size.unthrottled()).toEqual({ width: 640, height: 600 });

    await page.viewport(640, 480);
    await until(() => size.unthrottled().height === 480);
    expect(size.unthrottled()).toEqual({ width: 640, height: 480 });
  });

  it.runIf(chromium)('follows an emulated screen orientation', async () => {
    const o = orientation({ injector: injector() });
    try {
      await session().send('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        screenOrientation: { type: 'landscapePrimary', angle: 90 },
      });
      await until(() => o().angle === 90);
      expect(o()).toEqual({ angle: 90, type: 'landscape-primary' });
    } finally {
      await session().send('Emulation.clearDeviceMetricsOverride');
    }
  });
});

describe.runIf(chromium)('media and geolocation', () => {
  it('mediaQuery follows emulated media and a viewport breakpoint', async () => {
    await page.viewport(800, 600);
    const dark = prefersDarkMode({ injector: injector() });
    const narrow = mediaQuery('(max-width: 600px)', { injector: injector() });
    try {
      await session().send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
      await until(() => dark());
      expect(dark()).toBe(true);
      await session().send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
      await until(() => !dark());
      expect(dark()).toBe(false);
    } finally {
      await session().send('Emulation.setEmulatedMedia', { features: [] });
    }

    expect(narrow()).toBe(false);
    await page.viewport(500, 600);
    await until(() => narrow());
    expect(narrow()).toBe(true);
  });

  it('geolocation reports a granted position, a move, and a denial', async () => {
    await permissions('Browser.grantPermissions', {
      permissions: ['geolocation'],
    });
    const at = (latitude: number, longitude: number) =>
      session().send('Emulation.setGeolocationOverride', {
        latitude,
        longitude,
        accuracy: 1,
      });
    try {
      await at(46.05, 14.5);
      const watched = geolocation({ watch: true, injector: injector() });
      await until(() => !watched.loading());
      expect([
        watched()?.coords.latitude,
        watched()?.coords.longitude,
        watched.error(),
      ]).toEqual([46.05, 14.5, null]);

      await at(45.8, 15.97);
      await until(() => watched()?.coords.latitude === 45.8);
      expect(watched()?.coords.longitude).toBe(15.97);

      await permissions('Browser.resetPermissions');
      await permissions('Browser.setPermission', {
        permission: { name: 'geolocation' },
        setting: 'denied',
      });
      const denied = geolocation({ injector: injector() });
      await until(() => !denied.loading());
      expect([denied(), denied.error()?.code]).toEqual([null, 1]);
    } finally {
      await session().send('Emulation.clearGeolocationOverride');
      await permissions('Browser.resetPermissions');
    }
  });
});

describe.runIf(chromium)('clipboard', () => {
  it('mirrors a real copy of a selection, not the previous clipboard text', async () => {
    await permissions('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    const p = document.createElement('p');
    p.textContent = 'copied by the user';
    document.body.appendChild(p);
    await userEvent.click(p);
    try {
      const clip = clipboard({ injector: injector() });
      await clip.copy('before');
      await settle();
      expect(clip()).toBe('before');

      getSelection()?.selectAllChildren(p);
      await userEvent.keyboard('{ControlOrMeta>}c{/ControlOrMeta}');
      await until(() => clip() !== 'before');
      expect(await navigator.clipboard.readText()).toBe('copied by the user');
      expect(clip()).toBe('copied by the user');
    } finally {
      await permissions('Browser.resetPermissions');
    }
  });
});
