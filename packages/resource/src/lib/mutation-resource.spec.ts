import { HttpContext, HttpContextToken, HttpErrorResponse, HttpResponse, provideHttpClient, withInterceptors, withNoXsrfProtection, type HttpRequest } from '@angular/common/http';
import { PLATFORM_ID, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { delay, of, throwError } from 'rxjs';
import { mutationResource } from './mutation-resource';
import { provideQueryCache, ResourceSensors } from './util';

const TEST_CONTEXT = new HttpContextToken<{
  validate: (req: HttpRequest<any>) => void;
  returnValue: any;
  shouldThrow: boolean;
  delayMs: number;
}>(() => ({ validate: () => { /* noop */ }, returnValue: null, shouldThrow: false, delayMs: 0 }));

function createTestContext(validate: (req: HttpRequest<any>) => void, returnValue: any, shouldThrow = false, delayMs = 0) {
  return new HttpContext().set(TEST_CONTEXT, { validate, returnValue, shouldThrow, delayMs });
}

const testInterceptor = (req: HttpRequest<any>) => {
  const { validate, shouldThrow, returnValue, delayMs } = req.context.get(TEST_CONTEXT);
  validate(req);
  
  if (shouldThrow) {
    const err$ = throwError(() => new HttpErrorResponse({ error: 'Test error', status: 500 }));
    return delayMs ? err$.pipe(delay(delayMs)) : err$;
  }
  
  const res$ = of(new HttpResponse({ body: returnValue, status: 200 }));
  return delayMs ? res$.pipe(delay(delayMs)) : res$;
};

describe('mutationResource', () => {
  let networkStatusSignal: WritableSignal<boolean>;

  beforeEach(() => {
    networkStatusSignal = signal(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        {
          provide: ResourceSensors,
          useValue: { networkStatus: networkStatusSignal },
        },
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });
  });

  it('should execute mutation and call lifecycle hooks with correct context', async () => {
    const hooks: string[] = [];
    let requests = 0;
    
    // We will await a promise that resolves in onSettled
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource((body: { id: number }) => ({
        url: `https://example.com/mutate/${body.id}`,
        method: 'POST',
        body,
        context: createTestContext((req) => {
           expect(req.body).toEqual(body);
           requests++;
        }, { success: true }),
      }), {
        onMutate: (value) => {
          hooks.push('onMutate');
          return { originalId: value.id };
        },
        onSuccess: (result, ctx) => {
          hooks.push('onSuccess');
          expect(result).toEqual({ success: true });
          expect(ctx).toEqual({ originalId: 1 });
        },
        onError: () => {
          hooks.push('onError');
        },
        onSettled: (ctx) => {
          hooks.push('onSettled');
          expect(ctx).toEqual({ originalId: 1 });
          resolve();
        }
      })
    );

    res.mutate({ id: 1 });
    // while mutating, current should be set
    expect(res.current()).toEqual({ id: 1 });

    await promise;

    expect(requests).toBe(1);
    expect(hooks).toEqual(['onMutate', 'onSuccess', 'onSettled']);
    expect(res.current()).toBeNull(); // should be cleared
  });

  it('should call onError when request fails', async () => {
    const hooks: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const res = TestBed.runInInjectionContext(() =>
      mutationResource((body: any) => ({
        url: 'https://example.com/fail',
        method: 'POST',
        body,
        context: createTestContext(() => { /* noop */ }, null, true),
      }), {
        onMutate: () => hooks.push('onMutate'),
        onSuccess: () => hooks.push('onSuccess'),
        onError: () => hooks.push('onError'),
        onSettled: () => {
          hooks.push('onSettled');
          resolve();
        }
      })
    );

    res.mutate({ data: 'fail' });
    await promise;

    expect(hooks).toEqual(['onMutate', 'onError', 'onSettled']);
  });

  it('should queue mutations if queue is true', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    const res = TestBed.runInInjectionContext(() =>
      mutationResource((body: number) => ({
        url: `https://example.com/queue/${body}`,
        method: 'POST',
        body,
        context: createTestContext(() => {
          executions.push(body);
        }, { queued: body }, false, 10), // provide a non-null return value
      }), {
        queue: true,
        onSettled: () => {
          settledCount++;
        }
      })
    );

    res.mutate(1);
    res.mutate(2);
    res.mutate(3);

    for (let i = 0; i < 50; i++) {
        if (settledCount === 3) break;
        await new Promise(r => setTimeout(r, 10));
        TestBed.flushEffects();
    }

    expect(settledCount).toBe(3);
    // Ordered executions
    expect(executions).toEqual([1, 2, 3]);
  });

  it('should queue mutations while offline and flush them sequentially when online', async () => {
    const executions: number[] = [];
    let settledCount = 0;

    networkStatusSignal.set(false); // start offline

    const res = TestBed.runInInjectionContext(() =>
      mutationResource((body: number) => ({
        url: `https://example.com/queue-offline/${body}`,
        method: 'POST',
        body,
        context: createTestContext(() => {
          executions.push(body);
        }, { queued: body }, false, 10), 
      }), {
        queue: true,
        onSettled: () => {
          settledCount++;
        }
      })
    );

    res.mutate(1);
    res.mutate(2);

    TestBed.flushEffects();

    // It should have dequeued the first item but pending at network layer
    expect(res.current()).toEqual(1);
    expect(executions.length).toBe(0); // network didn't fire
    
    // Wait a bit to ensure it really doesn't fire
    await new Promise(r => setTimeout(r, 40));
    expect(executions.length).toBe(0);

    // Go online!
    networkStatusSignal.set(true);

    // Repeatedly flush effects until settledCount === 2
    for (let i = 0; i < 50; i++) {
        if (settledCount === 2) break;
        await new Promise(r => setTimeout(r, 10));
        TestBed.flushEffects();
    }

    expect(settledCount).toBe(2);
    // Ordered executions happened after coming online
    expect(executions).toEqual([1, 2]);
  });
});
