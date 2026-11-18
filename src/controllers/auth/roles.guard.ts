import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../domain/role.enum';
import { AuthenticatedRequest } from './authenticated-request';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * Global role guard (second `APP_GUARD`, after `JwtAuthGuard`). Public routes pass. Every other
 * route passes only when the authenticated principal holds one of its `@Roles(...)`; a route with
 * no roles is denied (default deny).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** @param reflector Reads the `@Public` and `@Roles` metadata. */
  constructor(private readonly reflector: Reflector) {}

  /**
   * Authorizes the request.
   *
   * @param context The execution context of the current request.
   * @returns `true` when the route is public or the principal holds an accepted role.
   * @throws ForbiddenException `forbidden` (403) otherwise.
   */
  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? [];
    const { principal } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!principal.hasAnyRole(roles)) {
      throw new ForbiddenException('forbidden');
    }
    return true;
  }
}
