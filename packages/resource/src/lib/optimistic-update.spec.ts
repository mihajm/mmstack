import { HttpContext, HttpContextToken, HttpErrorResponse, HttpResponse, provideHttpClient, withInterceptors, withNoXsrfProtection, type HttpRequest } from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { until } from '@mmstack/primitives';
import { delay, of, throwError } from 'rxjs';
import { mutationResource } from './mutation-resource';
import { queryResource } from './query-resource';
import { provideQueryCache } from './util';

const TEST_CONTEXT = new HttpContextToken<{
  shouldThrow: boolean;
  delayMs: number;
  returnValue: any;
}>(() => ({ shouldThrow: false, delayMs: 0, returnValue: null }));

function createTestContext(returnValue: any, shouldThrow = false, delayMs = 0) {
  return new HttpContext().set(TEST_CONTEXT, { shouldThrow, delayMs, returnValue });
}

const testInterceptor = (req: HttpRequest<any>) => {
  const { shouldThrow, returnValue, delayMs } = req.context.get(TEST_CONTEXT);
  
  if (shouldThrow) {
    const err$ = throwError(() => new HttpErrorResponse({ error: 'Test error', status: 500 }));
    return delayMs ? err$.pipe(delay(delayMs)) : err$;
  }
  
  const res$ = of(new HttpResponse({ body: returnValue, status: 200 }));
  return delayMs ? res$.pipe(delay(delayMs)) : res$;
};

describe('Optimistic Updates Integration', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([testInterceptor]),
        ),
      ],
    });
  });

  it('should optimistically update queryResource and keep the update on success', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();

    await TestBed.runInInjectionContext(async () => {
        const query = queryResource<{ id: number; name: string }[]>(() => ({
            url: 'https://example.com/items',
            context: createTestContext([{ id: 1, name: 'Item 1' }])
        }));

        const mutation = mutationResource<any, any, { name: string }, { previousItems: {id: number, name: string}[] }>((body) => ({
            url: 'https://example.com/items',
            method: 'POST',
            body,
            context: createTestContext({ id: 2, name: body.name }, false, 20)
        }), {
            onMutate: (newItem) => {
                const previousItems = query.value() ?? [];
                
                query.update(items => [
                    ...(items ?? []),
                    { id: -1, name: newItem.name } // temporary ID
                ]);

                return { previousItems };
            },
            onSuccess: (result) => {
                query.update(items => {
                    const newItems = [...(items ?? [])];
                    if (newItems.length > 0) {
                        newItems[newItems.length - 1] = result;
                    }
                    return newItems;
                });
            },
            onError: (err, ctx) => {
                query.set(ctx.previousItems);
            },
            onSettled: () => {
                resolve();
            }
        });

        await until(query.value, v => v !== undefined);
        expect(query.value()).toEqual([{ id: 1, name: 'Item 1' }]);

        mutation.mutate({ name: 'Optimistic Item' });
        
        const optimisticValue = query.value();
        expect(optimisticValue?.length).toBe(2);
        expect(optimisticValue?.[1].name).toBe('Optimistic Item');
        expect(optimisticValue?.[1].id).toBe(-1); // Temp ID

        await promise;

        const finalValue = query.value();
        expect(finalValue?.length).toBe(2);
        expect(finalValue?.[1].id).toBe(2); // Updated with REAL id from server
        expect(finalValue?.[1].name).toBe('Optimistic Item');
    });
  });

  it('should optimistically update queryResource and rollback on error', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();

    await TestBed.runInInjectionContext(async () => {
        const query = queryResource<{ id: number; name: string }[]>(() => ({
            url: 'https://example.com/items',
            context: createTestContext([{ id: 1, name: 'Item 1' }])
        }));

        const mutation = mutationResource<any, any, { name: string }, { previousItems: {id: number, name: string}[] }>((body) => ({
            url: 'https://example.com/items',
            method: 'POST',
            body,
            context: createTestContext(null, true, 20)
        }), {
            onMutate: (newItem) => {
                const previousItems = query.value() ?? [];
                
                query.update(items => [
                    ...(items ?? []),
                    { id: -1, name: newItem.name } // temporary ID
                ]);

                return { previousItems };
            },
            onError: (err, ctx) => {
                query.set(ctx.previousItems);
            },
            onSettled: () => {
                resolve();
            }
        });

        await until(query.value, v => v !== undefined);
        expect(query.value()).toEqual([{ id: 1, name: 'Item 1' }]);

        mutation.mutate({ name: 'Failing Item' });
        
        const optimisticValue = query.value();
        expect(optimisticValue?.length).toBe(2);
        expect(optimisticValue?.[1].name).toBe('Failing Item');

        await promise;

        const finalValue = query.value();
        expect(finalValue?.length).toBe(1);
        expect(finalValue).toEqual([{ id: 1, name: 'Item 1' }]);
    });
  });
});
