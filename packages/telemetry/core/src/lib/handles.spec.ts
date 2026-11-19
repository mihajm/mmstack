import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TelemetryHandles } from './handles';
import { memorySink } from './memory-sink';
import { provideTelemetry } from './provide';
import { type SpanHandle } from './sink';
import { TELEMETRY } from './telemetry';
import { tracedBy } from './traced-signal';

describe('TelemetryHandles', () => {
  it('keys() lists published keys in publish order and tracks new ones', () => {
    const handles = TestBed.inject(TelemetryHandles);
    const keys = handles.keys();
    let runs = 0;
    const seen = computed(() => {
      runs++;
      return keys();
    });

    expect(seen()).toEqual([]);
    handles.publish('a', signal(1));
    handles.publish('b', signal(2));
    expect(seen()).toEqual(['a', 'b']);
    handles.publish('c', signal(3));
    expect(seen()).toEqual(['a', 'b', 'c']);
    expect(runs).toBe(3);
  });

  it('get() is undefined until published, then tracks the handle', () => {
    const handles = TestBed.inject(TelemetryHandles);
    const url = handles.get<string>('replay.url');
    expect(url()).toBeUndefined();
    const source = signal('u1');
    handles.publish('replay.url', source);
    expect(url()).toBe('u1');
    source.set('u2');
    expect(url()).toBe('u2');
  });
});

describe('tracedBy', () => {
  it('records the active span at each write and keeps the written value', () => {
    TestBed.configureTestingModule({
      providers: [provideTelemetry({ sinks: [memorySink()] })],
    });
    const telemetry = TestBed.inject(TELEMETRY);
    const sig = TestBed.runInInjectionContext(() => tracedBy(signal(0)));

    let a: SpanHandle | undefined;
    telemetry.span('a', (s) => {
      a = s;
      sig.set(1);
    });
    expect(a).toBeDefined();
    expect(sig()).toBe(1);
    expect(sig.causedBy()).toBe(a);

    sig.set(2);
    expect(sig()).toBe(2);
    expect(sig.causedBy()).toBeUndefined();
  });
});
