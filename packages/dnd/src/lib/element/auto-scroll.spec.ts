import { Component, ElementRef, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { autoScroll } from './auto-scroll';
import { provideDnd, ɵclearWarnedPlugins, type AutoScrollPlugin } from '../provide';

const scrollMock = vi.fn();
const scrollCleanup = vi.fn();
const plugin: AutoScrollPlugin = (args) => {
  scrollMock(args);
  return scrollCleanup;
};

@Component({ selector: 'mm-test-autoscroll', template: '' })
class Host {
  constructor() {
    autoScroll();
  }
}

beforeEach(() => {
  TestBed.resetTestingModule();
  scrollMock.mockReset();
  scrollCleanup.mockReset();
  ɵclearWarnedPlugins();
});

describe('autoScroll', () => {
  it('warns and no-ops (does not throw) when no plugin is registered', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
      ],
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() =>
      TestBed.runInInjectionContext(() => autoScroll()),
    ).not.toThrow(); // missing plugin degrades gracefully now (dev warn + no-op)
    spy.mockRestore();
  });

  it('invokes the registered plugin with the host element after render', async () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scrollMock).toHaveBeenCalledOnce();
    expect(scrollMock.mock.calls[0][0].element).toBe(
      fixture.nativeElement,
    );
  });

  it('cleans up the plugin on destroy', async () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scrollCleanup).not.toHaveBeenCalled();
    fixture.destroy();
    expect(scrollCleanup).toHaveBeenCalledOnce();
  });

  it('prefers a per-call override plugin over the DI default', async () => {
    const override = vi.fn(() => () => undefined);
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    @Component({ selector: 'mm-test-override', template: '' })
    class OverrideHost {
      constructor() {
        autoScroll({ autoScroll: override as AutoScrollPlugin });
      }
    }
    const fixture = TestBed.createComponent(OverrideHost);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(override).toHaveBeenCalledOnce();
    expect(scrollMock).not.toHaveBeenCalled();
  });

  it('uses an explicit element option and passes extra config through to the plugin', async () => {
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { autoScroll: plugin } })],
    });
    const custom = document.createElement('section');
    @Component({ selector: 'mm-test-el', template: '' })
    class ElHost {
      constructor() {
        autoScroll({ element: custom, maxScrollSpeed: 'fast' });
      }
    }
    const fixture = TestBed.createComponent(ElHost);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scrollMock).toHaveBeenCalledOnce();
    const arg = scrollMock.mock.calls[0][0];
    expect(arg.element).toBe(custom); // overrides the host
    expect(arg.maxScrollSpeed).toBe('fast'); // extra config forwarded
    expect(arg.autoScroll).toBeUndefined(); // ...but not the internal keys
    expect(arg.injector).toBeUndefined();
  });

  it('is a no-op on the server (no throw, no call)', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
        // intentionally NO plugin registered — server must not throw
      ],
    });
    expect(() =>
      TestBed.runInInjectionContext(() => autoScroll()),
    ).not.toThrow();
    expect(scrollMock).not.toHaveBeenCalled();
  });
});
