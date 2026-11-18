/** Why a refresh was refused. Logged for operators, never returned to the client. */
export enum RefreshFailureReason {
  /** No stored token has the presented hash. */
  UNKNOWN = 'UNKNOWN',
  /** The token was not revoked but its expiry has passed. */
  EXPIRED = 'EXPIRED',
  /** The token was already used or revoked; its family is revoked. */
  REUSED = 'REUSED',
  /** The owner may not log in (status not `ACTIVE`); its family is revoked. */
  INACTIVE_USER = 'INACTIVE_USER',
  /** The family has reached its absolute session limit. */
  SESSION_EXPIRED = 'SESSION_EXPIRED',
}

/**
 * Raised for every failed refresh. The message is the same for every reason, so the response never
 * reveals the token or account state; only {@link InvalidRefreshTokenError.reason} differs and it
 * is only logged. Maps to HTTP 401.
 */
export class InvalidRefreshTokenError extends Error {
  /**
   * Creates the error with the fixed message `invalid refresh token`.
   *
   * @param reason Why the refresh was refused (for logs only).
   */
  constructor(readonly reason: RefreshFailureReason) {
    super('invalid refresh token');
    this.name = 'InvalidRefreshTokenError';
  }
}
