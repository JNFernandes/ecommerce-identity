import { Role } from '../domain/role.enum';

/** Command to replace a user's roles on behalf of an admin (`PUT /users/{id}/roles`). */
export class ChangeUserRolesCommand {
  /**
   * @param targetId The id (UUID) of the user whose roles change.
   * @param roles The roles the user must hold after the command (replaces the current ones).
   * @param actingAdminId The id of the admin making the change (the access token's `sub`).
   */
  constructor(
    readonly targetId: string,
    readonly roles: readonly Role[],
    readonly actingAdminId: string,
  ) {}
}
