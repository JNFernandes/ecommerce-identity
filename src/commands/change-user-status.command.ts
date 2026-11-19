import { UserStatus } from '../domain/user-status.enum';

/** Command to set a user's status to `ACTIVE` or `DISABLED` on behalf of an admin. */
export class ChangeUserStatusCommand {
  /**
   * @param targetId The id (UUID) of the user whose status changes.
   * @param status The status the user must have after the command.
   * @param actingAdminId The id of the admin making the change (the access token's `sub`).
   */
  constructor(
    readonly targetId: string,
    readonly status: UserStatus,
    readonly actingAdminId: string,
  ) {}
}
