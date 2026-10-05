import { JsonPipe } from '@angular/common';
import { Component, signal, type ResourceStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outcomeOf } from '../concurrent/outcome';
import {
  DONE,
  error,
  errorEdge,
  isStrictSentinels,
  joinSentinelRegistry,
  loading,
  type ErrorMintReport,
  SentinelLeakError,
  SentinelRegistryError,
  setErrorReporter,
  setStrictSentinels,
} from './sentinel';

const KEY = Symbol.for('@mmstack/primitives.sentinels');

let reports: ErrorMintReport[];
const leaks = () => reports.filter((r) => r.origin === 'leak');

beforeEach(() => {
  reports = [];
  setErrorReporter((r) => reports.push(r));
});

afterEach(() => {
  setErrorReporter(undefined);
  setStrictSentinels(false);
});

describe('sentinel coercion policy', () => {
  it('is soft by default', () => {
    expect(isStrictSentinels()).toBe(false);
  });

  it('[PIN soft] renders a tagged string and reports the leak once per sentinel', () => {
    const s = loading();
    expect(String(s)).toBe('[mmstack loading]');
    expect(`${s}`).toBe('[mmstack loading]');
    expect(s + '').toBe('[mmstack loading]');
    expect(s.toString()).toBe('[mmstack loading]');
    expect(JSON.stringify(s)).toBe('{"$sentinel":"loading"}');
    expect(leaks()).toHaveLength(1);
    const [report] = leaks();
    expect(report.subclass).toBe('author-fault');
    expect(report.cause).toBeInstanceOf(SentinelLeakError);

    const other = loading();
    expect(String(other)).toBe('[mmstack loading]');
    expect(leaks()).toHaveLength(2);
  });

  it('[PIN soft] a number coercion is NaN', () => {
    const s = loading();
    expect(Number(s)).toBeNaN();
    expect(+(s as unknown as number)).toBeNaN();
    expect(leaks()).toHaveLength(1);
  });

  it('[PIN stable] the string is stable per kind', () => {
    const failed = error('x');
    expect([String(loading()), String(loading())]).toEqual([
      '[mmstack loading]',
      '[mmstack loading]',
    ]);
    expect(String(failed)).toBe('[mmstack error]');
    expect(String(errorEdge(new Error('503')))).toBe('[mmstack error]');
    expect(String(DONE)).toBe('[mmstack done]');
    expect(JSON.stringify(failed)).toBe('{"$sentinel":"error"}');
    expect(JSON.stringify(DONE)).toBe('{"$sentinel":"done"}');
  });

  it('[PIN json] JSON.stringify of an outcome holding a sentinel yields the tagged object', () => {
    const status = signal<ResourceStatus>('loading');
    const err = signal<unknown>(undefined);
    const ref = {
      status,
      value: signal<number | undefined>(undefined),
      hasValue: () => false,
      error: err,
    };
    const out = outcomeOf(ref);
    expect(JSON.stringify({ outcome: out() })).toBe(
      '{"outcome":{"$sentinel":"loading"}}',
    );
    err.set(new Error('503'));
    status.set('error');
    expect(JSON.stringify({ outcome: out() })).toBe(
      '{"outcome":{"$sentinel":"error"}}',
    );
    // one mint report (the edge) + one leak per sentinel
    expect(reports.map((r) => r.origin)).toEqual(['leak', 'edge', 'leak']);
  });

  it('[PIN template] {{ outcome }} and | json render instead of throwing every pass', () => {
    @Component({
      selector: 'mm-leak-host',
      imports: [JsonPipe],
      template: `<p>{{ out() }}</p>
        <pre>{{ out() | json }}</pre>`,
    })
    class LeakHost {
      readonly out = signal<unknown>(loading());
    }
    const fixture = TestBed.createComponent(LeakHost);
    fixture.detectChanges();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('p')?.textContent).toBe('[mmstack loading]');
    expect(JSON.parse(el.querySelector('pre')?.textContent ?? '')).toEqual({
      $sentinel: 'loading',
    });
    expect(leaks()).toHaveLength(1);
  });

  it('[PIN strict] strict mode throws SentinelLeakError at every boundary and reports nothing', () => {
    setStrictSentinels(true);
    expect(isStrictSentinels()).toBe(true);
    const s = loading();
    expect(() => String(s)).toThrow(SentinelLeakError);
    expect(() => `${s}`).toThrow(SentinelLeakError);
    expect(() => Number(s)).toThrow(SentinelLeakError);
    expect(() => s.toString()).toThrow(SentinelLeakError);
    expect(() => JSON.stringify(s)).toThrow(SentinelLeakError);
    expect(() => JSON.stringify(DONE)).toThrow(/sentinel leaked/);
    expect(leaks()).toHaveLength(0);
    setStrictSentinels(false);
    expect(String(s)).toBe('[mmstack loading]');
  });

  it('[PIN shared] the flag lives on the realm registry, so every copy reads and writes the same one', () => {
    const record = (globalThis as unknown as Record<symbol, unknown>)[KEY] as {
      policy: { strict: boolean };
    };
    // a second copy joining the slot gets the same record and the same policy object
    expect(joinSentinelRegistry().policy).toBe(record.policy);
    setStrictSentinels(true);
    expect(record.policy.strict).toBe(true);
    // what another copy's setStrictSentinels(false) does: write the shared record
    record.policy.strict = false;
    expect(isStrictSentinels()).toBe(false);
    expect(String(loading())).toBe('[mmstack loading]');
    record.policy.strict = true;
    expect(() => String(loading())).toThrow(SentinelLeakError);
  });

  it('[PIN registry] a record from a copy without the policy is still joined; a malformed policy fails loud', () => {
    const older = {
      protocol: 2,
      sentinels: new WeakSet<object>(),
      aware: new WeakSet<object>(),
    };
    expect(joinSentinelRegistry({ [KEY]: older }).policy).toBeUndefined();
    expect(() =>
      joinSentinelRegistry({ [KEY]: { ...older, policy: { strict: 'no' } } }),
    ).toThrow(SentinelRegistryError);
    const fresh: Record<symbol, unknown> = {};
    expect(joinSentinelRegistry(fresh).policy).toEqual({ strict: false });
  });
});
