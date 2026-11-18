/** Why an access token or the caller it names was refused. Logged only, never returned. */
export enum AccessTokenFailureReason {
  /** There is no `Authorization` header. */
  MISSING_HEADER = 'MISSING_HEADER',
  /** The scheme is not Bearer, the value is empty, or there are extra spaces or two tokens. */
  MALFORMED_HEADER = 'MALFORMED_HEADER',
  /** The value is not a decodable JWT. */
  MALFORMED_TOKEN = 'MALFORMED_TOKEN',
  /** The `alg` header is anything other than `RS256`. */
  UNSUPPORTED_ALGORITHM = 'UNSUPPORTED_ALGORITHM',
  /** The `kid` header is missing or names no published key. */
  UNKNOWN_KEY = 'UNKNOWN_KEY',
  /** The signature does not verify. */
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  /** `exp` is in the past by more than the clock tolerance. */
  EXPIRED = 'EXPIRED',
  /** `iat` or `nbf` is in the future by more than the clock tolerance. */
  NOT_YET_VALID = 'NOT_YET_VALID',
  /** `iss` or `aud` does not match the configuration. */
  CLAIM_MISMATCH = 'CLAIM_MISMATCH',
  /** `sub`, `iat`, `exp`, `jti` or `roles` is missing or malformed, or `customerId` is not a string. */
  INVALID_CLAIMS = 'INVALID_CLAIMS',
  /** The user named by the token is missing or not `ACTIVE`. */
  USER_UNAVAILABLE = 'USER_UNAVAILABLE',
}

/**
 * Raised for every refused access token. The message is the same for every reason, so the response
 * never reveals why the token failed; only {@link InvalidAccessTokenError.reason} differs and it is
 * only logged. Maps to HTTP 401.
 */
export class InvalidAccessTokenError extends Error {
  /**
   * Creates the error with the fixed message `unauthorized`.
   *
   * @param reason Why the token was refused (for logs only).
   */
  constructor(readonly reason: AccessTokenFailureReason) {
    super('unauthorized');
    this.name = 'InvalidAccessTokenError';
  }
}
