import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { Response } from 'express';
import { REGISTER_THROTTLER } from '../../../src/controllers/auth.controller';
import {
  LOGIN_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
} from '../../../src/controllers/login-throttle.tracker';
import { JwksController } from '../../../src/controllers/jwks.controller';
import { JwksService, JwksSnapshot } from '../../../src/services/jwks.service';

/** A minimal Express response that records what the controller writes. */
function fakeResponse(): {
  res: Response;
  headers: Record<string, string | number>;
  status: jest.Mock;
  end: jest.Mock;
} {
  const headers: Record<string, string | number> = {};
  const status = jest.fn();
  const end = jest.fn();
  const res = {
    status,
    end,
    setHeader: (name: string, value: string | number) => {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as Response;
  return { res, headers, status, end };
}

describe('JwksController', () => {
  const snapshot: JwksSnapshot = {
    body: '{"keys":[{"kid":"é"}]}',
    etag: '"etag-value"',
    cacheControl: 'public, max-age=300',
  };
  const controller = new JwksController({ current: () => snapshot } as unknown as JwksService);

  it('should send the precomputed body with JSON, caching and ETag headers', () => {
    const { res, headers, status, end } = fakeResponse();

    controller.getKeySet(undefined, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      etag: '"etag-value"',
      'content-length': Buffer.byteLength(snapshot.body),
    });
    expect(end).toHaveBeenCalledWith(snapshot.body);
  });

  it.each(['"etag-value"', '"old", W/"etag-value"', '*'])(
    'should answer 304 with the caching headers and no body for If-None-Match %p',
    (ifNoneMatch) => {
      const { res, headers, status, end } = fakeResponse();

      controller.getKeySet(ifNoneMatch, res);

      expect(status).toHaveBeenCalledWith(304);
      expect(headers).toEqual({ 'cache-control': 'public, max-age=300', etag: '"etag-value"' });
      expect(end).toHaveBeenCalledWith();
    },
  );

  it('should send the full body for a stale If-None-Match', () => {
    const { res, status, end } = fakeResponse();

    controller.getKeySet('"stale"', res);

    expect(status).toHaveBeenCalledWith(200);
    expect(end).toHaveBeenCalledWith(snapshot.body);
  });

  const handler: unknown = Object.getOwnPropertyDescriptor(
    JwksController.prototype,
    'getKeySet',
  )?.value;

  it('should have no guards, so the endpoint stays public', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, JwksController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, handler as object)).toBeUndefined();
  });

  it.each([REGISTER_THROTTLER, LOGIN_IP_THROTTLER, LOGIN_EMAIL_THROTTLER])(
    'should skip the %s throttler',
    (name) => {
      expect(Reflect.getMetadata(`${THROTTLER_SKIP}${name}`, JwksController)).toBe(true);
    },
  );
});
