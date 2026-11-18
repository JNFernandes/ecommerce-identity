import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../../../src/controllers/auth/jwt-auth.guard';
import { Public } from '../../../../src/controllers/auth/public.decorator';
import { Roles } from '../../../../src/controllers/auth/roles.decorator';
import { AuthenticatedPrincipal } from '../../../../src/domain/authenticated-principal';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../../src/domain/errors/invalid-access-token.error';
import { Role } from '../../../../src/domain/role.enum';
import { AccessTokenVerifier } from '../../../../src/services/ports/access-token-verifier';

@Public()
class PublicController {
  handler(): void {}
}

class ProtectedController {
  @Roles(Role.CUSTOMER)
  handler(): void {}

  @Public()
  open(): void {}
}

interface FakeRequest {
  headers: { authorization?: string };
  principal?: AuthenticatedPrincipal;
}

function contextFor(
  controller: new () => object,
  handler: () => void,
  request: FakeRequest,
): ExecutionContext {
  return {
    getHandler: (): (() => void) => handler,
    getClass: (): new () => object => controller,
    switchToHttp: (): object => ({ getRequest: (): FakeRequest => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const principal = AuthenticatedPrincipal.fromClaims({ sub: 'user-1', roles: ['CUSTOMER'] });
  let verify: jest.Mock<Promise<AuthenticatedPrincipal>, [string]>;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    verify = jest.fn<Promise<AuthenticatedPrincipal>, [string]>().mockResolvedValue(principal);
    const verifier: AccessTokenVerifier = { verify };
    guard = new JwtAuthGuard(new Reflector(), verifier);
  });

  const protectedRoute = (request: FakeRequest): ExecutionContext =>
    contextFor(ProtectedController, ProtectedController.prototype.handler, request);

  async function expectReason(
    request: FakeRequest,
    reason: AccessTokenFailureReason,
  ): Promise<void> {
    const result = guard.canActivate(protectedRoute(request));
    await expect(result).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(result).rejects.toMatchObject({ reason });
    expect(verify).not.toHaveBeenCalled();
  }

  it('should let a public controller through without reading an invalid header', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer invalid' } };

    await expect(
      guard.canActivate(contextFor(PublicController, PublicController.prototype.handler, request)),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
  });

  it('should let a public handler through without a header', async () => {
    await expect(
      guard.canActivate(
        contextFor(ProtectedController, ProtectedController.prototype.open, { headers: {} }),
      ),
    ).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('should reject a missing header', async () => {
    await expectReason({ headers: {} }, AccessTokenFailureReason.MISSING_HEADER);
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer  abc', 'Bearer abc def', 'abc', ''])(
    'should reject the malformed header %p',
    async (authorization) => {
      await expectReason({ headers: { authorization } }, AccessTokenFailureReason.MALFORMED_HEADER);
    },
  );

  it.each(['Bearer abc.def.ghi', 'bearer abc.def.ghi', 'BEARER abc.def.ghi'])(
    'should verify the token of %p and attach the principal',
    async (authorization) => {
      const request: FakeRequest = { headers: { authorization } };

      await expect(guard.canActivate(protectedRoute(request))).resolves.toBe(true);
      expect(verify).toHaveBeenCalledWith('abc.def.ghi');
      expect(request.principal).toBe(principal);
    },
  );

  it('should propagate a verifier error unchanged', async () => {
    const error = new InvalidAccessTokenError(AccessTokenFailureReason.EXPIRED);
    verify.mockRejectedValue(error);

    await expect(
      guard.canActivate(protectedRoute({ headers: { authorization: 'Bearer abc' } })),
    ).rejects.toBe(error);
  });
});
