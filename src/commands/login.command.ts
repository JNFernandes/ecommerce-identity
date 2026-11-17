/**
 * Command to log in with email and password. Carries the raw client input; the handler applies
 * the domain rules. The password is plain text here and must never be logged.
 */
export class LoginCommand {
  /**
   * @param email The email as the client sent it (normalized by the domain).
   * @param password The plain password, exactly as the client sent it (never trimmed).
   * @param clientIp The client IP, used for logging only.
   */
  constructor(
    readonly email: string,
    readonly password: string,
    readonly clientIp: string | undefined,
  ) {}
}
