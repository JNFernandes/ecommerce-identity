import { RefreshFailureReason } from './errors/invalid-refresh-token.error';
import { RefreshTokenState } from './refresh-token-state.enum';
import { RefreshToken } from './refresh-token.aggregate';
import { User } from './user.aggregate';

/** The presented token may be rotated; carries the usable token and its active owner. */
export interface RotateDecision {
  kind: 'rotate';
  /** The token to rotate. */
  token: RefreshToken;
  /** Its owner, allowed to log in. */
  user: User;
}

/** The refresh is refused; `revokeFamily` says whether the whole family must be revoked first. */
export interface RefuseDecision {
  kind: 'refuse';
  /** Why the refresh is refused (logged only). */
  reason: RefreshFailureReason;
  /** Whether every unrevoked token of the family must be revoked. */
  revokeFamily: boolean;
}

/** Outcome of {@link RefreshPolicy.decide}. */
export type RefreshDecision = RotateDecision | RefuseDecision;

/** Input of {@link RefreshPolicy.decide}. */
export interface RefreshPolicyInput {
  /** The stored token found by the presented value's hash, or `null` when none matches. */
  token: RefreshToken | null;
  /** The token's owner as currently stored, or `null` when it no longer exists. */
  user: User | null;
  /** The current time. */
  now: Date;
}

/**
 * The refresh rules: whether a presented token may be rotated and, when it may not, whether the
 * whole family must be revoked. Pure; the service only carries out the decision.
 */
export class RefreshPolicy {
  private constructor() {}

  /**
   * Decides a refresh, in this order: unknown token → refuse; revoked (used, logged out or
   * family-revoked) → refuse and revoke the family; expired → refuse, family kept; owner missing or
   * not allowed to log in → refuse and revoke the family; otherwise rotate.
   *
   * @param input The stored token, its owner and the current time.
   */
  static decide({ token, user, now }: RefreshPolicyInput): RefreshDecision {
    if (token === null) {
      return refuse(RefreshFailureReason.UNKNOWN, false);
    }
    const state = token.assess(now);
    if (state === RefreshTokenState.REUSED) {
      return refuse(RefreshFailureReason.REUSED, true);
    }
    if (state === RefreshTokenState.EXPIRED) {
      return refuse(RefreshFailureReason.EXPIRED, false);
    }
    if (user === null || !user.canLogin()) {
      return refuse(RefreshFailureReason.INACTIVE_USER, true);
    }
    return { kind: 'rotate', token, user };
  }
}

function refuse(reason: RefreshFailureReason, revokeFamily: boolean): RefuseDecision {
  return { kind: 'refuse', reason, revokeFamily };
}
