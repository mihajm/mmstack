import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { PreloadRequester } from './preload-requester';

describe('PreloadRequester', () => {
  let requester: PreloadRequester;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    requester = TestBed.inject(PreloadRequester);
  });

  it('should emit preload requests (scope defaults to all)', async () => {
    const req = firstValueFrom(requester.preloadRequested$);
    requester.startPreload('user/:id');

    const value = await req;
    expect(value).toEqual({ path: 'user/:id', scope: 'all' });
  });

  it('carries an explicit scope (code-only warms the chunk, not route data)', async () => {
    const req = firstValueFrom(requester.preloadRequested$);
    requester.startPreload('user/:id', 'code');

    const value = await req;
    expect(value).toEqual({ path: 'user/:id', scope: 'code' });
  });
});
