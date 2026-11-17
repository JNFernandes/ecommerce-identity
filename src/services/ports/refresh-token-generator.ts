/** A newly generated refresh token. */
export interface GeneratedRefreshToken {
  /** The clear opaque value, returned to the client once. Never stored or logged. */
  value: string;
  /** SHA-256 hex digest of `value`, the only form that is stored. */
  hash: string;
}

/** Port for creating and hashing opaque refresh tokens. Used as the Nest injection token. */
export abstract class RefreshTokenGenerator {
  /** Generates a new random token and its hash. */
  abstract generate(): GeneratedRefreshToken;

  /**
   * Hashes a token value the same way `generate` does, to look up a presented token.
   *
   * @param value The clear value.
   */
  abstract hash(value: string): string;
}
