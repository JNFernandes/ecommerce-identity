import { ArgumentsHost, Logger } from '@nestjs/common';
import { AccessTokenExceptionFilter } from '../../../../src/controllers/auth/access-token-exception.filter';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../../src/domain/errors/invalid-access-token.error';

interface CapturedResponse {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

interface FakeResponse {
  status(code: number): FakeResponse;
  setHeader(name: string, value: string): FakeResponse;
  json(body: unknown): FakeResponse;
}

function run(reason: AccessTokenFailureReason): CapturedResponse {
  const captured: CapturedResponse = { headers: {} };
  const response: FakeResponse = {
    status(code: number): FakeResponse {
      captured.status = code;
      return response;
    },
    setHeader(name: string, value: string): FakeResponse {
      captured.headers[name] = value;
      return response;
    },
    json(body: unknown): FakeResponse {
      captured.body = JSON.stringify(body);
      return response;
    },
  };
  const host = {
    switchToHttp: (): object => ({ getResponse: (): FakeResponse => response }),
  } as unknown as ArgumentsHost;
  new AccessTokenExceptionFilter().catch(new InvalidAccessTokenError(reason), host);
  return captured;
}

describe('AccessTokenExceptionFilter', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('should respond 401 with WWW-Authenticate: Bearer and the generic body', () => {
    const response = run(AccessTokenFailureReason.EXPIRED);

    expect(response.status).toBe(401);
    expect(response.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    expect(response.body).toBe(
      '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}',
    );
  });

  it('should give the same response for two different reasons', () => {
    expect(run(AccessTokenFailureReason.MISSING_HEADER)).toEqual(
      run(AccessTokenFailureReason.INVALID_SIGNATURE),
    );
  });

  it('should log the reason at warn without a token', () => {
    run(AccessTokenFailureReason.UNKNOWN_KEY);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('UNKNOWN_KEY');
    expect(line).not.toMatch(/eyJ|Bearer/);
  });
});
