import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sensor, sensors } from './sensor';

const MATCHING = new Set(['(prefers-color-scheme: dark)', '(custom: yes)']);

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: MATCHING.has(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

type AnySensor = (() => unknown) & Record<string, unknown>;

function has(s: AnySensor, ...members: string[]) {
  return members.every((m) => m in s);
}

describe('sensor', () => {
  let host: HTMLElement;
  let child: HTMLButtonElement;

  beforeEach(() => {
    stubMatchMedia();
    host = document.createElement('div');
    child = document.createElement('button');
    host.appendChild(child);
    document.body.appendChild(host);
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(host) }],
    });
  });

  afterEach(() => {
    child.blur();
    host.remove();
  });

  const make = (type: string, opts?: unknown) =>
    TestBed.runInInjectionContext(
      () => (sensor as any)(type, opts) as AnySensor,
    );

  it('should initialize sensors correctly', () => {
    TestBed.runInInjectionContext(() => {
      const tracking = sensors(
        ['darkMode', 'networkStatus', 'elementSize', 'mediaQuery'],
        {
          elementSize: { target: document.createElement('div') },
          networkStatus: {},
          darkMode: {},
          mediaQuery: { query: '(custom: yes)' },
        },
      );
      expect(tracking.darkMode()).toBe(true);
      expect(typeof tracking.networkStatus()).toBe('boolean');
      expect(tracking.mediaQuery()).toBe(true);
      expect('visible' in tracking.elementSize).toBe(false);
    });
  });

  it('should throw for unknown sensor type', () => {
    expect(() => sensor('unknown' as any)).toThrowError(
      /Unknown sensor type: unknown/,
    );
  });

  const cases: [string, unknown, (s: AnySensor) => void][] = [
    [
      'mousePosition',
      undefined,
      (s) => {
        expect(has(s, 'unthrottled')).toBe(true);
        expect(has(s, 'cancel')).toBe(false);
        expect(s()).toEqual({ x: 0, y: 0 });
      },
    ],
    [
      'pointerDrag',
      undefined,
      (s) => {
        expect(has(s, 'cancel', 'unthrottled')).toBe(true);
        expect(s()).toMatchObject({ active: false, pointerId: null });
      },
    ],
    [
      'networkStatus',
      undefined,
      (s) => {
        expect(typeof s()).toBe('boolean');
        expect(has(s, 'since')).toBe(true);
      },
    ],
    [
      'pageVisibility',
      undefined,
      (s) => expect(['visible', 'hidden']).toContain(s()),
    ],
    ['darkMode', undefined, (s) => expect(s()).toBe(true)],
    ['dark-mode', undefined, (s) => expect(s()).toBe(true)],
    ['reducedMotion', undefined, (s) => expect(s()).toBe(false)],
    ['reduced-motion', undefined, (s) => expect(s()).toBe(false)],
    ['mediaQuery', { query: '(custom: yes)' }, (s) => expect(s()).toBe(true)],
    [
      'windowSize',
      undefined,
      (s) => {
        expect(s()).toEqual({
          width: window.innerWidth,
          height: window.innerHeight,
        });
        expect(has(s, 'unthrottled')).toBe(true);
      },
    ],
    [
      'scrollPosition',
      undefined,
      (s) => {
        expect(s()).toEqual({ x: 0, y: 0 });
        expect(has(s, 'unthrottled')).toBe(true);
      },
    ],
    [
      'elementVisibility',
      { target: document.createElement('div') },
      (s) => {
        expect(has(s, 'visible')).toBe(true);
        expect(s()).toBeUndefined();
      },
    ],
    [
      'elementSize',
      { target: document.createElement('div') },
      (s) => {
        expect(has(s, 'visible', 'error')).toBe(false);
        expect(s()).toEqual({ width: 0, height: 0 });
      },
    ],
    [
      'geolocation',
      undefined,
      (s) => {
        expect(has(s, 'error', 'loading')).toBe(true);
        expect(has(s, 'copy')).toBe(false);
      },
    ],
    [
      'clipboard',
      undefined,
      (s) => {
        expect(has(s, 'copy', 'isSupported')).toBe(true);
        expect(typeof s()).toBe('string');
      },
    ],
    [
      'orientation',
      undefined,
      (s) => expect(s()).toMatchObject({ angle: expect.any(Number) }),
    ],
    [
      'batteryStatus',
      undefined,
      (s) => {
        expect(s()).toBeNull();
        expect(has(s, 'since')).toBe(false);
      },
    ],
    [
      'idle',
      undefined,
      (s) => {
        expect(s()).toBe(false);
        expect(has(s, 'since')).toBe(true);
      },
    ],
    [
      'focusWithin',
      { target: document.createElement('div') },
      (s) => {
        expect(s()).toBe(false);
        expect(has(s, 'since')).toBe(false);
      },
    ],
  ];

  it.each(cases)('dispatches %s to its own sensor', (type, opts, check) => {
    check(make(type, opts));
  });

  it.each(['elementVisibility', 'elementSize'])(
    '%s defaults to the injected host element when called without options',
    (type) => {
      expect(() => make(type)).not.toThrow();
    },
  );

  it('focusWithin defaults to the injected host element', () => {
    child.focus();
    expect(make('focusWithin')()).toBe(true);
  });
});
