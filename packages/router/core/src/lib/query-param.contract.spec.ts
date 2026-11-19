import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  convertToParamMap,
  type ParamMap,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { queryParam } from './query-param';

let navigate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigate = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: Router, useValue: { navigate } },
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: new Subject<ParamMap>(),
          snapshot: {
            queryParamMap: convertToParamMap({}),
          } as unknown as ActivatedRouteSnapshot,
        },
      },
    ],
  });
});

const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
const extrasOf = (call: number) => navigate.mock.calls[call][1];

describe('queryParam contract: batching', () => {
  it('a batch where every writer asked for replaceUrl replaces the history entry', async () => {
    const [a, b] = run(() => [
      queryParam('a', { batch: true, replaceUrl: true }),
      queryParam('b', { batch: true, replaceUrl: true }),
    ]);
    a.set('1');
    b.set('2');
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(extrasOf(0).replaceUrl).toBe(true);
    expect(extrasOf(0).queryParams).toEqual({ a: '1', b: '2' });
  });

  it('a later batch after a flush navigates again', async () => {
    const a = run(() => queryParam('a', { batch: true }));
    a.set('1');
    await Promise.resolve();
    a.set('2');
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(extrasOf(1).queryParams).toEqual({ a: '2' });
  });
});

describe('queryParam contract: debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces writes inside the window into one navigation with the last value', () => {
    const q = run(() => queryParam('q', { debounce: 300 }));
    q.set('a');
    q.set('b');
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(extrasOf(0).queryParams).toEqual({ q: 'b' });
  });

  it('writes under the key that was current when set() ran', () => {
    const key = signal('a');
    const q = run(() => queryParam(key, { debounce: 300 }));
    q.set('x');
    key.set('b');
    vi.advanceTimersByTime(300);
    expect(extrasOf(0).queryParams).toEqual({ a: 'x' });
  });

  it('a pending write does not navigate after its owner is destroyed', () => {
    const env = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    const q = runInInjectionContext(env, () =>
      queryParam('q', { debounce: 300 }),
    );
    q.set('a');
    env.destroy();
    vi.advanceTimersByTime(300);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('queryParam contract: parse and serialize', () => {
  it('an absent param is null without calling parse', () => {
    const parse = vi.fn(Number);
    const q = run(() => queryParam<number>('n', { parse, serialize: String }));
    expect(q()).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('set(null) removes the param without calling serialize', () => {
    const serialize = vi.fn(String);
    const q = run(() => queryParam<number>('n', { parse: Number, serialize }));
    q.set(null);
    expect(serialize).not.toHaveBeenCalled();
    expect(extrasOf(0).queryParams).toEqual({ n: null });
  });
});
