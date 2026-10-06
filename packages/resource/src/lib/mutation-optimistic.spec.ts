import {
  HttpErrorResponse,
  type HttpEvent,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpRequest,
} from '@angular/common/http';
import { Injector, PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  guessable,
  injectTransitionScope,
  optimistic,
  provideTransitionScope,
  type Transaction,
} from '@mmstack/primitives';
import { Subject } from 'rxjs';
import { MutationCancelledError, mutationResource } from './mutation-resource';

type Call = {
  readonly body: unknown;
  readonly res: Subject<HttpEvent<unknown>>;
};
let calls: Call[] = [];
const server = (req: HttpRequest<unknown>) => {
  const res = new Subject<HttpEvent<unknown>>();
  calls.push({ body: req.body, res });
  return res;
};
const ok = (i: number, body: unknown) => {
  calls[i].res.next(new HttpResponse({ body, status: 200 }));
  calls[i].res.complete();
};
const fail = (i: number) =>
  calls[i].res.error(new HttpErrorResponse({ error: 'nope', status: 500 }));

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
};

function setup<T>(
  initial: T,
  queue = false,
  layAuthoritative?: (n: ReturnType<typeof guessable<T>>, v: T) => void,
) {
  return TestBed.runInInjectionContext(() => {
    const node = guessable(signal(initial));
    const scope = injectTransitionScope();
    const txs: Transaction[] = [];
    const save = mutationResource<T, T, T>(
      (body) => ({ url: 'https://example.com/save', method: 'POST', body }),
      {
        queue,
        optimistic: (v, tx) => {
          txs.push(tx);
          tx.guess(node, v);
          layAuthoritative?.(node, v);
        },
        onSuccess: (saved) => node.set(saved), // the reconcile
      },
    );
    return { node, scope, save, txs };
  });
}

describe('mutationResource({ optimistic })', () => {
  beforeEach(() => {
    calls = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideTransitionScope(),
        provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
      ],
    });
  });

  it('success: the guess shows while in flight, the reconcile lands, then the transaction completes and the hold ends', async () => {
    const { node, scope, save, txs } = setup('off');
    save.mutate('on');
    expect(node()).toBe('on');
    expect(node.truth()).toBe('off');
    expect(scope.holding()).toBe(true);
    await flush();
    expect(calls.length).toBe(1);
    expect(node()).toBe('on');
    ok(0, 'on');
    await flush();
    expect([node(), node.truth()]).toEqual(['on', 'on']);
    expect(txs[0].closed).toBe(true);
    expect(scope.holding()).toBe(false);
    expect(save.lastFailure()).toBeUndefined();
  });

  it('failure: the guess and the authoritative writes made inside revert, and lastFailure latches', async () => {
    const { node, scope, save, txs } = setup(1, false, (n, v) => n.set(v * 10));
    save.mutate(2);
    expect([node(), node.truth()]).toEqual([20, 20]); // a write after a guess buries it
    await flush();
    fail(0);
    await flush();
    expect([node(), node.truth()]).toEqual([1, 1]);
    expect(txs[0].closed).toBe(true);
    expect(scope.holding()).toBe(false);
    expect(save.lastFailure()?.generation).toBe(1);
  });

  it('latest-wins: a supersede aborts the older run at once, its guess is gone, the newer guess shows', async () => {
    const { node, save, txs } = setup('a');
    const first = save.mutateAsync('b').catch((e) => e);
    await flush();
    save.mutate('c');
    expect(txs[0].closed).toBe(true); // aborted synchronously, no render needed
    expect(txs[1].closed).toBe(false);
    expect(node()).toBe('c');
    const err = await first;
    expect(err).toBeInstanceOf(MutationCancelledError);
    expect((err as MutationCancelledError).type).toBe('superseded');
    await flush();
    ok(calls.length - 1, 'c');
    await flush();
    expect([node(), node.truth()]).toEqual(['c', 'c']);
    expect(txs[1].closed).toBe(true);
  });

  it('FIFO queue: each run lays its guesses when it starts, in order, and each settles on its own outcome', async () => {
    const { node, save, txs } = setup(0, true);
    const seen: number[] = [];
    const look = () => seen.push(node());
    save.mutate(1);
    save.mutate(2);
    await flush();
    look(); // run 1 in flight
    expect(txs.length).toBe(1);
    ok(0, 1);
    await flush();
    look(); // run 1 reconciled, run 2 in flight with its guess
    expect(txs.length).toBe(2);
    expect(txs[0].closed).toBe(true);
    fail(1);
    await flush();
    look(); // run 2 failed: its guess is gone, run 1's reconcile stays
    expect(seen).toEqual([1, 2, 1]);
    expect(txs[1].closed).toBe(true);
    expect(node.truth()).toBe(1);
  });

  it('destroy aborts the open run and drops its guess', async () => {
    const { node, save, txs } = setup('x');
    save.mutate('y');
    expect(node()).toBe('y');
    save.destroy();
    expect(txs[0].closed).toBe(true);
    expect(node()).toBe('x');
  });

  it('a throwing optimistic cancels the mutation like a throwing onMutate', async () => {
    const save = TestBed.runInInjectionContext(() =>
      mutationResource<string, string, string>(
        (body) => ({ url: 'https://example.com/save', method: 'POST', body }),
        {
          optimistic: () => {
            throw new Error('bad guess');
          },
        },
      ),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(save.mutateAsync('v')).rejects.toThrow('bad guess');
    await flush();
    expect(calls.length).toBe(0);
    expect(save.current()).toBeNull();
    spy.mockRestore();
  });

  it('works with the overlay tier: only the view sees the guess', async () => {
    const injector = TestBed.inject(Injector);
    const liked = signal(false);
    const view = optimistic(liked);
    const save = TestBed.runInInjectionContext(() =>
      mutationResource<boolean, boolean, boolean>(
        (body) => ({ url: 'https://example.com/like', method: 'POST', body }),
        {
          injector,
          optimistic: (v, tx) => tx.overlay(view).set(v),
          onSuccess: (v) => liked.set(v),
        },
      ),
    );
    save.mutate(true);
    expect([view(), liked()]).toEqual([true, false]);
    await flush();
    fail(0);
    await flush();
    expect([view(), liked()]).toEqual([false, false]);
    save.mutate(true);
    await flush();
    ok(1, true);
    await flush();
    expect([view(), liked()]).toEqual([true, true]);
  });

  it('a run whose request() returns undefined aborts at once and never holds the scope', async () => {
    const { node, scope, txs, save } = TestBed.runInInjectionContext(() => {
      const node = guessable(signal('a'));
      const scope = injectTransitionScope();
      const txs: Transaction[] = [];
      const save = mutationResource<string, string, string>(() => undefined, {
        optimistic: (v, tx) => {
          txs.push(tx);
          tx.guess(node, v);
        },
      });
      return { node, scope, txs, save };
    });
    save.mutate('b');
    expect([txs[0].closed, node(), scope.holding()]).toEqual([
      true,
      'a',
      false,
    ]);
    await flush();
    expect(calls.length).toBe(0);
  });

  it('without optimistic, no transaction opens', async () => {
    const { scope } = setup('a');
    const plain = TestBed.runInInjectionContext(() =>
      mutationResource<string, string, string>((body) => ({
        url: 'https://example.com/save',
        method: 'POST',
        body,
      })),
    );
    plain.mutate('b');
    expect(scope.holding()).toBe(false);
    await flush();
    ok(0, 'b');
    await flush();
  });
});
