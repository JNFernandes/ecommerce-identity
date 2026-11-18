/** How a presented refresh token is classified at a given time (see `RefreshToken.assess`). */
export enum RefreshTokenState {
  /** Not revoked and not expired: may be rotated. */
  USABLE = 'USABLE',
  /** Not revoked, but its expiry has passed. */
  EXPIRED = 'EXPIRED',
  /** Already used or revoked (whether or not it has also expired): presenting it is reuse. */
  REUSED = 'REUSED',
}
