import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DndAnnouncer, injectAnnounce } from './a11y';
import { provideDnd } from '../provide';

function regions(politeness: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[aria-live="${politeness}"]`),
  );
}

describe('DndAnnouncer', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.body.querySelectorAll('[aria-live]').forEach((el) => el.remove());
  });

  it('creates polite and assertive live regions', () => {
    TestBed.inject(DndAnnouncer);
    expect(regions('polite')).toHaveLength(1);
    expect(regions('assertive')).toHaveLength(1);
    expect(regions('polite')[0].getAttribute('role')).toBe('status');
    expect(regions('assertive')[0].getAttribute('role')).toBe('alert');
  });

  it('announces into the polite region by default', () => {
    const a = TestBed.inject(DndAnnouncer);
    a.announce('Moved card to position 2');
    expect(regions('polite')[0].textContent).toBe('Moved card to position 2');
  });

  it('routes assertive messages to the assertive region', () => {
    const a = TestBed.inject(DndAnnouncer);
    a.announce('Deleted', 'assertive');
    expect(regions('assertive')[0].textContent).toBe('Deleted');
  });

  it('re-announces identical consecutive messages (toggled)', () => {
    const a = TestBed.inject(DndAnnouncer);
    a.announce('same');
    const first = regions('polite')[0].textContent;
    a.announce('same');
    const second = regions('polite')[0].textContent;
    expect(second).not.toBe(first);
    expect(second?.startsWith('same')).toBe(true);
  });

  it('creates no regions on the server', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
    TestBed.inject(DndAnnouncer);
    expect(regions('polite')).toHaveLength(0);
  });
});

describe('injectAnnounce (pluggable)', () => {
  it('falls back to the built-in DndAnnouncer when no plugin is registered', () => {
    TestBed.resetTestingModule();
    document.body.querySelectorAll('[aria-live]').forEach((el) => el.remove());
    TestBed.runInInjectionContext(() => injectAnnounce()('hello'));
    expect(regions('polite')[0]?.textContent).toBe('hello');
  });

  it('uses a registered announce plugin instead', () => {
    const calls: string[] = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideDnd({ plugins: { announce: (m) => calls.push(m) } })],
    });
    TestBed.runInInjectionContext(() => injectAnnounce()('via plugin'));
    expect(calls).toEqual(['via plugin']);
  });
});
