import { randomUUID } from 'node:crypto';

/** Full state of a refresh token, as stored. The clear token value is never part of it. */
export interface RefreshTokenProps {
  /** Token id (UUID). */
  id: string;
  /** Owner's user id (UUID). */
  userId: string;
  /** Rotation family (UUID); a new login starts a new family. */
  familyId: string;
  /** SHA-256 hash of the opaque value (64 hex characters). */
  tokenHash: string;
  /** Issue time. */
  createdAt: Date;
  /** Expiry time. */
  expiresAt: Date;
  /** Revocation time, or `null` while the token is not revoked. */
  revokedAt: Date | null;
  /** Id of the token that replaced this one on rotation, or `null`. */
  replacedBy: string | null;
}

/** Input of {@link RefreshToken.issue}. */
export interface IssueRefreshTokenInput {
  /** Owner's user id. */
  userId: string;
  /** SHA-256 hash of the generated opaque value. */
  tokenHash: string;
  /** Issue time. */
  issuedAt: Date;
  /** Lifetime in seconds; must be positive. */
  ttlSeconds: number;
}

/** The refresh token aggregate: one opaque, single-use session credential, stored hashed. */
export class RefreshToken {
  private constructor(private readonly props: RefreshTokenProps) {}

  /**
   * Issues a token for a new login: new `id` and `familyId`, `expiresAt = issuedAt + ttl`, not
   * revoked.
   *
   * @param input Owner, hash, issue time and lifetime.
   * @throws Error When the lifetime is not positive or the hash is empty.
   */
  static issue({ userId, tokenHash, issuedAt, ttlSeconds }: IssueRefreshTokenInput): RefreshToken {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('refresh token lifetime must be positive');
    }
    if (tokenHash.length === 0) {
      throw new Error('refresh token hash must not be empty');
    }
    return new RefreshToken({
      id: randomUUID(),
      userId,
      familyId: randomUUID(),
      tokenHash,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000),
      revokedAt: null,
      replacedBy: null,
    });
  }

  /**
   * Rebuilds a token from persisted state.
   *
   * @param props The stored state.
   */
  static restore(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken({ ...props });
  }

  /** Token id (UUID). */
  get id(): string {
    return this.props.id;
  }

  /** Owner's user id. */
  get userId(): string {
    return this.props.userId;
  }

  /** Rotation family id. */
  get familyId(): string {
    return this.props.familyId;
  }

  /** SHA-256 hash of the opaque value. */
  get tokenHash(): string {
    return this.props.tokenHash;
  }

  /** Issue time. */
  get createdAt(): Date {
    return this.props.createdAt;
  }

  /** Expiry time. */
  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  /** Revocation time, or `null`. */
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  /** Successor token id, or `null`. */
  get replacedBy(): string | null {
    return this.props.replacedBy;
  }
}
