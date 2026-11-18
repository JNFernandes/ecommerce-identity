import { randomUUID } from 'node:crypto';
import { RefreshTokenState } from './refresh-token-state.enum';

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

/** Input of {@link RefreshToken.issueInFamily}. */
export interface IssueInFamilyInput {
  /** Owner's user id. */
  userId: string;
  /** Family the successor joins. */
  familyId: string;
  /** SHA-256 hash of the generated opaque value. */
  tokenHash: string;
  /** Issue time. */
  issuedAt: Date;
  /** Expiry time; must be after `issuedAt`. */
  expiresAt: Date;
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
   * Issues the successor of a rotated token: new `id`, the given family, not revoked.
   *
   * @param input Owner, family, hash, issue time and expiry.
   * @throws Error When the hash is empty or `expiresAt` is not after `issuedAt`.
   */
  static issueInFamily({
    userId,
    familyId,
    tokenHash,
    issuedAt,
    expiresAt,
  }: IssueInFamilyInput): RefreshToken {
    if (tokenHash.length === 0) {
      throw new Error('refresh token hash must not be empty');
    }
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw new Error('refresh token must expire after it is issued');
    }
    return new RefreshToken({
      id: randomUUID(),
      userId,
      familyId,
      tokenHash,
      createdAt: issuedAt,
      expiresAt,
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

  /**
   * Classifies the token at `now`. Revocation is checked first, so a token that is both revoked and
   * expired counts as reuse.
   *
   * @param now The current time.
   * @returns `REUSED` if revoked, otherwise `EXPIRED` if `now >= expiresAt`, otherwise `USABLE`.
   */
  assess(now: Date): RefreshTokenState {
    if (this.props.revokedAt !== null) {
      return RefreshTokenState.REUSED;
    }
    if (now.getTime() >= this.props.expiresAt.getTime()) {
      return RefreshTokenState.EXPIRED;
    }
    return RefreshTokenState.USABLE;
  }

  /**
   * Whether the token may be rotated at `now`.
   *
   * @param now The current time.
   */
  isUsable(now: Date): boolean {
    return this.assess(now) === RefreshTokenState.USABLE;
  }

  /**
   * Marks the token as used: revoked at `now` and replaced by `newTokenId`.
   *
   * @param newTokenId Id of the successor token.
   * @param now The rotation time.
   * @throws Error When the successor id is empty or the token is not usable at `now`.
   */
  rotate(newTokenId: string, now: Date): void {
    if (newTokenId.length === 0) {
      throw new Error('successor token id must not be empty');
    }
    if (!this.isUsable(now)) {
      throw new Error('only a usable refresh token can be rotated');
    }
    this.props.revokedAt = now;
    this.props.replacedBy = newTokenId;
  }
}
