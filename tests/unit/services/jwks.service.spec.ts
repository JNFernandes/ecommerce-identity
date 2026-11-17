import { JwksService } from '../../../src/services/jwks.service';
import { PublicKeySet } from '../../../src/services/ports/public-key-set';

describe('JwksService', () => {
  const keySet: PublicKeySet = { json: '{"keys":[{"kid":"a"}]}', etag: '"abc"' };

  it('should return the precomputed body and ETag with the configured max-age', () => {
    const service = new JwksService(keySet, 300);

    expect(service.current()).toEqual({
      body: '{"keys":[{"kid":"a"}]}',
      etag: '"abc"',
      cacheControl: 'public, max-age=300',
    });
  });

  it('should allow max-age=0 so clients revalidate every time', () => {
    expect(new JwksService(keySet, 0).current().cacheControl).toBe('public, max-age=0');
  });

  it('should serve the same snapshot on every call', () => {
    const service = new JwksService(keySet, 60);

    expect(service.current()).toBe(service.current());
  });
});
