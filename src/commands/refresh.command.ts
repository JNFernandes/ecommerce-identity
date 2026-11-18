/**
 * Command to exchange a refresh token for a new access token and refresh token. The token is a
 * secret and must never be logged.
 */
export class RefreshCommand {
  /**
   * @param refreshToken The opaque refresh token, exactly as the client sent it.
   * @param clientIp The client IP, used for logging only.
   */
  constructor(
    readonly refreshToken: string,
    readonly clientIp: string | undefined,
  ) {}
}
