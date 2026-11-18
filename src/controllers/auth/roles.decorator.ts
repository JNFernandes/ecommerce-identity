import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { Role } from '../../domain/role.enum';

/** Metadata key set by {@link Roles}. */
export const ROLES_KEY = 'identity:roles';

/**
 * Restricts a handler or a whole controller to callers holding at least one of the roles. The caller
 * must present a valid access token (401 otherwise) and hold a listed role (403 otherwise).
 *
 * @param roles The accepted roles; must not be empty.
 */
export const Roles = (...roles: Role[]): CustomDecorator<string> => SetMetadata(ROLES_KEY, roles);
