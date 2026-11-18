import { applyDecorators, SetMetadata } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role } from '../../domain/role.enum';

/** Metadata key set by {@link Roles}. */
export const ROLES_KEY = 'identity:roles';

/**
 * Restricts a handler or a whole controller to callers holding at least one of the roles. The caller
 * must present a valid access token (401 otherwise) and hold a listed role (403 otherwise).
 *
 * It also documents the route in Swagger (bearer scheme, `x-roles`, 401 and 403), so the docs cannot
 * drift from what is enforced.
 *
 * @param roles The accepted roles; must not be empty (startup fails otherwise).
 */
export function Roles(...roles: Role[]): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    ApiBearerAuth(),
    ApiExtension('x-roles', roles),
    ApiUnauthorizedResponse({
      description:
        'Missing, malformed, expired or untrusted access token, or the user is no longer active. ' +
        'Always `{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}` with ' +
        '`WWW-Authenticate: Bearer`.',
    }),
    ApiForbiddenResponse({
      description: `The caller holds none of the roles ${roles.join(', ')}. Body \`{"statusCode":403,"message":"forbidden","error":"Forbidden"}\`.`,
    }),
  );
}
