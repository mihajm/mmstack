import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpInterceptorFn,
  HttpResponse,
  provideHttpClient,
  withInterceptors,
  withNoXsrfProtection,
} from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { isLoading } from '@mmstack/primitives';
import { Observable } from 'rxjs';
import { infiniteQueryResource } from './infinite-query';
import { provideMockQueryCache, provideMockResourceSensors } from './util';

type Page = { items: string[]; nextCursor: number | null };
type Pending = { cursor: number; respond: () => void; fail: () => void };

let inFlight: Pending[];
let requested: number[];

const pageFor = (cursor: number): Page => ({
  items: [`item-${cursor * 2}`, `item-${cursor * 2 + 1}`],
  nextCursor: cursor >= 2 ? null : cursor + 1,
});

const server: HttpInterceptorFn = (req) =>
  new Observable<HttpEvent<unknown>>((sub) => {
    const cursor = Number(req.params.get('cursor'));
    requested.push(cursor);
    inFlight.push({
      cursor,
      respond: () => {
        sub.next(new HttpResponse({ status: 200, body: pageFor(cursor) }));
        sub.complete();
      },
      fail: () => sub.error(new HttpErrorResponse({ status: 500 })),
    });
  });

async function settle() {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
  }
}

const respondAll = async () => {
  while (inFlight.length) inFlight.shift()!.respond();
  await settle();
};

function create(keepPrevious = false) {
  return TestBed.runInInjectionContext(() =>
    infiniteQueryResource<Page, Page, number>(
      ({ pageParam }) => ({
        url: 'https://x/posts',
        params: { cursor: pageParam },
      }),
      {
        initialPageParam: 0,
        getNextPageParam: (last) => last.nextCursor,
        keepPrevious,
      },
    ),
  );
}

beforeEach(() => {
  inFlight = [];
  requested = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'browser' },
      provideMockQueryCache(),
      provideMockResourceSensors(),
      provideHttpClient(withNoXsrfProtection(), withInterceptors([server])),
    ],
  });
});

describe('infiniteQueryResource contract', () => {
  it('before the first page: no next page and no throw', async () => {
    const res = create();
    expect(res.hasNextPage()).toBe(false);
    await settle();
    expect(res.isLoading()).toBe(true);
    expect(res.isFetchingNextPage()).toBe(false);
    expect(isLoading(res.outcome())).toBe(true);
  });

  it('isFetchingNextPage is false once the first page settles, true while the next loads', async () => {
    const res = create();
    await settle();
    await respondAll();
    expect(res.isFetchingNextPage()).toBe(false);
    expect(res.outcome()).toEqual(res.pages());
    res.fetchNextPage();
    await settle();
    expect(res.isFetchingNextPage()).toBe(true);
    expect(res.outcome()).toEqual(res.pages());
  });

  it('with keepPrevious, a held page is not filed under the next param', async () => {
    const res = create(true);
    await settle();
    await respondAll();
    res.fetchNextPage();
    await settle();
    expect(res.pages().length).toBe(1);
    inFlight.shift()!.fail();
    await settle();
    expect(res.pages().length).toBe(1);
  });

  it('reload() of the only page replaces it and refetches', async () => {
    const res = create();
    await settle();
    await respondAll();
    expect(res.reload()).toBe(true);
    await settle();
    await respondAll();
    expect(requested).toEqual([0, 0]);
    expect(res.pages().length).toBe(1);
    expect(res.pages()[0].items).toEqual(['item-0', 'item-1']);
  });

  it('a reload replaces its slot and keeps the other pages', async () => {
    const res = create();
    await settle();
    await respondAll();
    res.fetchNextPage();
    await settle();
    await respondAll();
    res.reload();
    await settle();
    await respondAll();
    expect(res.pages().map((p) => p.items[0])).toEqual(['item-0', 'item-2']);
  });

  it('fetchNextPage() during a reload is a no-op', async () => {
    const res = create();
    await settle();
    await respondAll();
    res.reload();
    await settle();
    res.fetchNextPage();
    await settle();
    await respondAll();
    expect(requested).toEqual([0, 0]);
    expect(res.pages().length).toBe(1);
  });

  it('reset() on the initial page reloads it', async () => {
    const res = create();
    await settle();
    await respondAll();
    res.reset();
    await settle();
    await respondAll();
    expect(requested).toEqual([0, 0]);
    expect(res.pages().length).toBe(1);
  });

  it('destroy() mid-flight stops the query', async () => {
    const res = create();
    await settle();
    res.destroy();
    await settle();
    expect(res.status()).toBe('idle');
    expect(res.isLoading()).toBe(false);
  });
});
