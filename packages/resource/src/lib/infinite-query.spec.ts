import {
  HttpContext,
  HttpContextToken,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
  type HttpRequest,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  injectTransitionScope,
  provideTransitionScope,
} from '@mmstack/primitives';
import { Observable, of } from 'rxjs';
import { infiniteQueryResource } from './infinite-query';
import { provideQueryCache } from './util';

type PostPage = { items: string[]; nextCursor: number | null };

const TEST_CONTEXT = new HttpContextToken<{
  respond: (req: HttpRequest<unknown>) => unknown;
}>(() => ({ respond: () => null }));

const testInterceptor = (req: HttpRequest<unknown>) => {
  const { respond } = req.context.get(TEST_CONTEXT);
  return of(new HttpResponse({ body: respond(req), status: 200 }));
};

function pageFor(cursor: number): PostPage {
  const items = [`item-${cursor * 2}`, `item-${cursor * 2 + 1}`];
  return { items, nextCursor: cursor >= 2 ? null : cursor + 1 };
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
  TestBed.tick();
}

describe('infiniteQueryResource', () => {
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

  function create(onRequest?: (cursor: number) => void) {
    return TestBed.runInInjectionContext(() =>
      infiniteQueryResource<PostPage, PostPage, number>(
        ({ pageParam }) => ({
          url: `https://example.com/posts`,
          params: { cursor: pageParam },
          context: new HttpContext().set(TEST_CONTEXT, {
            respond: (req) => {
              const cursor = Number(req.params.get('cursor'));
              onRequest?.(cursor);
              return pageFor(cursor);
            },
          }),
        }),
        {
          initialPageParam: 0,
          getNextPageParam: (last) => last.nextCursor,
        },
      ),
    );
  }

  it('loads the first page automatically and accumulates on fetchNextPage', async () => {
    const res = create();
    await settle();

    expect(res.pages().length).toBe(1);
    expect(res.pages()[0].items).toEqual(['item-0', 'item-1']);
    expect(res.hasNextPage()).toBe(true);

    res.fetchNextPage();
    await settle();

    expect(res.pages().length).toBe(2);
    expect(res.pages()[1].items).toEqual(['item-2', 'item-3']);

    res.fetchNextPage();
    await settle();

    expect(res.pages().length).toBe(3);
    expect(res.hasNextPage()).toBe(false);

    res.fetchNextPage();
    await settle();
    expect(res.pages().length).toBe(3);
  });

  it('a reload replaces the current page instead of appending a duplicate', async () => {
    const res = create();
    await settle();
    res.fetchNextPage();
    await settle();
    expect(res.pages().length).toBe(2);

    res.reload();
    await settle();

    expect(res.pages().length).toBe(2);
    expect(res.pages()[1].items).toEqual(['item-2', 'item-3']);
  });

  it('reset drops all pages and refetches from the initial param', async () => {
    const requested: number[] = [];
    const res = create((cursor) => requested.push(cursor));
    await settle();
    res.fetchNextPage();
    await settle();
    expect(res.pages().length).toBe(2);

    res.reset();
    await settle();

    expect(res.pages().length).toBe(1);
    expect(res.pages()[0].items).toEqual(['item-0', 'item-1']);
    expect(requested).toEqual([0, 1, 0]);
  });
});

describe('infiniteQueryResource — transition scope integration', () => {
  let inFlight: Array<{ url: string; respond: (body: unknown) => void }>;
  const deferredInterceptor = (req: HttpRequest<unknown>) =>
    new Observable<HttpResponse<unknown>>((sub) => {
      inFlight.push({
        url: req.urlWithParams,
        respond: (body) => {
          sub.next(new HttpResponse({ body, status: 200 }));
          sub.complete();
        },
      });
    });

  beforeEach(() => {
    inFlight = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        provideQueryCache(),
        provideHttpClient(
          withNoXsrfProtection(),
          withInterceptors([deferredInterceptor]),
        ),
        provideTransitionScope(),
      ],
    });
  });

  function createScoped(register: 'suspend' | 'indicator') {
    return TestBed.runInInjectionContext(() => ({
      scope: injectTransitionScope(),
      res: infiniteQueryResource<PostPage, PostPage, number>(
        ({ pageParam }) => ({
          url: 'https://example.test/posts',
          params: { page: `${pageParam}` },
        }),
        {
          initialPageParam: 0,
          getNextPageParam: (last) => last.nextCursor,
          register,
        },
      ),
    }));
  }

  it("register: 'suspend' — the first page suspends, later pages only indicate (no placeholder mid-list)", async () => {
    const { scope, res } = createScoped('suspend');

    await settle();
    expect(scope.pending()).toBe(true);
    expect(scope.suspended('value')).toBe(true);

    inFlight.shift()?.respond(pageFor(0));
    await settle();
    expect(scope.suspended('value')).toBe(false);
    expect(res.pages().length).toBe(1);

    res.fetchNextPage();
    await settle();
    expect(res.isFetchingNextPage()).toBe(true);
    expect(scope.pending()).toBe(true);
    expect(scope.suspended('value')).toBe(false);

    inFlight.shift()?.respond(pageFor(1));
    await settle();
    expect(res.pages().length).toBe(2);
    expect(scope.pending()).toBe(false);
  });

  it('destroy() removes the aggregate registration from the scope', async () => {
    const { scope, res } = createScoped('indicator');
    await settle();
    expect(scope.resources().length).toBe(1);

    res.destroy();
    expect(scope.resources().length).toBe(0);
  });
});
