import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { windowSize } from './window-size';

describe('windowSize', () => {
  const start = { width: window.innerWidth, height: window.innerHeight };

  const resizeTo = (width: number, height: number) => {
    Object.assign(window, { innerWidth: width, innerHeight: height });
    window.dispatchEvent(new Event('resize'));
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.assign(window, {
      innerWidth: start.width,
      innerHeight: start.height,
    });
    vi.useRealTimers();
  });

  it('starts at the current size and follows a resize after the throttle window', () => {
    const size = TestBed.runInInjectionContext(() =>
      windowSize({ throttle: 100 }),
    );
    expect(size()).toEqual(start);

    resizeTo(800, 600);
    expect(size.unthrottled()).toEqual({ width: 800, height: 600 });
    expect(size()).toEqual(start);

    vi.advanceTimersByTime(100);
    expect(size()).toEqual({ width: 800, height: 600 });
  });

  it('defaults to a 100ms throttle when called bare', () => {
    const size = TestBed.runInInjectionContext(() => windowSize());
    expect(size()).toEqual(start);
    resizeTo(800, 600);
    vi.advanceTimersByTime(50);
    expect(size()).toEqual(start);
    vi.advanceTimersByTime(50);
    expect(size()).toEqual({ width: 800, height: 600 });
  });

  it('reports a width-only and then a height-only resize', () => {
    const size = TestBed.runInInjectionContext(() =>
      windowSize({ throttle: 0 }),
    );
    resizeTo(800, start.height);
    expect(size.unthrottled()).toEqual({ width: 800, height: start.height });
    resizeTo(800, 500);
    expect(size.unthrottled()).toEqual({ width: 800, height: 500 });
  });

  it('stops listening after destroy', () => {
    const injector = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const size = windowSize({ injector, throttle: 0 });
    injector.destroy();
    resizeTo(800, 600);
    expect(size.unthrottled()).toEqual(start);
  });

  it('is a static 1024x768 on the server, whatever the window says', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    Object.assign(window, { innerWidth: 500, innerHeight: 400 });
    const size = TestBed.runInInjectionContext(() => windowSize());
    expect(size()).toEqual({ width: 1024, height: 768 });
    expect(size.unthrottled()).toEqual({ width: 1024, height: 768 });
  });
});
