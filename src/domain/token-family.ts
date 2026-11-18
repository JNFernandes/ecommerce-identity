import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from './errors/invalid-refresh-token.error';

/** Input of {@link TokenFamily.create}. */
export interface CreateTokenFamilyInput {
  /** Session start: the creation time of the family's first token (the login). */
  startedAt: Date;
  /** Absolute session lifetime in seconds; must be positive. */
  maxSeconds: number;
}

/**
 * A refresh token family seen as one session with an absolute lifetime. No refresh token of the
 * family may expire after {@link TokenFamily.expiresAt}.
 */
export class TokenFamily {
  private constructor(
    /** Session start. */
    readonly startedAt: Date,
    /** Absolute session lifetime in seconds. */
    readonly maxSeconds: number,
  ) {}

  /**
   * Creates the session view of a family.
   *
   * @param input Session start and maximum age.
   * @throws Error When `maxSeconds` is not a positive number.
   */
  static create({ startedAt, maxSeconds }: CreateTokenFamilyInput): TokenFamily {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
      throw new Error('session lifetime must be positive');
    }
    return new TokenFamily(startedAt, maxSeconds);
  }

  /** End of the session: `startedAt + maxSeconds`. */
  get expiresAt(): Date {
    return new Date(this.startedAt.getTime() + this.maxSeconds * 1000);
  }

  /**
   * Expiry of the next refresh token issued at `now`: the earlier of `now + refreshTtlSeconds` and
   * the session end.
   *
   * @param now The issue time.
   * @param refreshTtlSeconds Refresh token lifetime in seconds.
   * @throws InvalidRefreshTokenError With reason `SESSION_EXPIRED` when the result is not after `now`.
   */
  nextTokenExpiry(now: Date, refreshTtlSeconds: number): Date {
    const byTtl = now.getTime() + refreshTtlSeconds * 1000;
    const expiry = Math.min(byTtl, this.expiresAt.getTime());
    if (expiry <= now.getTime()) {
      throw new InvalidRefreshTokenError(RefreshFailureReason.SESSION_EXPIRED);
    }
    return new Date(expiry);
  }
}
