import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedPrincipal } from '../../domain/authenticated-principal';
import { AuthenticatedRequest } from './authenticated-request';

/**
 * Returns the principal `JwtAuthGuard` attached to the request.
 *
 * @param _data Unused.
 * @param context The execution context of the current request.
 */
export function currentUserFactory(
  _data: unknown,
  context: ExecutionContext,
): AuthenticatedPrincipal {
  return context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
}

/**
 * Injects the caller of a protected route into a handler parameter, so handlers never parse
 * tokens. Only valid on routes declared with `@Roles(...)`.
 */
export const CurrentUser = createParamDecorator(currentUserFactory);
