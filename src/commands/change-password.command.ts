/**
 * Command to change the caller's own password. Carries the raw client input; the handler applies
 * the domain rules. Both passwords are plain text here and must never be logged.
 */
export class ChangePasswordCommand {
  /**
   * @param userId The caller's id, taken only from the verified access token.
   * @param currentPassword The current password, exactly as sent (never trimmed).
   * @param newPassword The new password, exactly as sent (never trimmed).
   */
  constructor(
    readonly userId: string,
    readonly currentPassword: string,
    readonly newPassword: string,
  ) {}
}
