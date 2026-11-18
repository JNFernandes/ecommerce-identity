import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../domain/errors/invalid-access-token.error';
import { AccessTokenVerifier } from '../../services/ports/access-token-verifier';
import { AuthenticatedRequest } from './authenticated-request';
import { IS_PUBLIC_KEY } from './public.decorator';

/** `Bearer <token>`: case-insensitive scheme, one space, exactly one token. */
const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * Global authentication guard (first `APP_GUARD`). Public routes pass without the header being read.
 * Every other route needs a valid `Authorization: Bearer <access token>`; the verified principal is
 * attached to the request as `principal`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  /**
   * @param reflector Reads the `@Public` metadata.
   * @param verifier Verifies the access token locally.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  /**
   * Authenticates the request.
   *
   * @param context The execution context of the current request.
   * @returns `true` when the route is public or the token is valid.
   * @throws InvalidAccessTokenError When the header is missing or malformed, or the token is refused.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (header === undefined) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.MISSING_HEADER);
    }
    const match = BEARER.exec(header);
    if (match === null) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.MALFORMED_HEADER);
    }
    request.principal = await this.verifier.verify(match[1]);
    return true;
  }
}
