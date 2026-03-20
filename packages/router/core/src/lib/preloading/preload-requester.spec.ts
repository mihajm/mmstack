import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { PreloadRequester } from './preload-requester';

describe('PreloadRequester', () => {
  let requester: PreloadRequester;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    requester = TestBed.inject(PreloadRequester);
  });

  it('should emit preload requests', async () => {
    const req = firstValueFrom(requester.preloadRequested$);
    requester.startPreload('user/:id');
    
    const value = await req;
    expect(value).toBe('user/:id');
  });
});
