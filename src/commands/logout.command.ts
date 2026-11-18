/**
 * Command to end the session a refresh token belongs to. The token is a secret and must never be
 * logged.
 */
export class LogoutCommand {
  /**
   * @param refreshToken The opaque refresh token, exactly as the client sent it.
   * @param clientIp The client IP, used for logging only.
   */
  constructor(
    readonly refreshToken: string,
    readonly clientIp: string | undefined,
  ) {}
}
