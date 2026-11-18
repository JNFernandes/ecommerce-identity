import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from './errors/invalid-access-token.error';
import { Role } from './role.enum';

const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.values(Role));

/** Narrows an unknown value to a known {@link Role}. */
function isRole(value: unknown): value is Role {
  return typeof value === 'string' && KNOWN_ROLES.has(value);
}

/** Narrows an unknown value to a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Throws the generic access token error for a claim set that cannot form a principal. */
function invalidClaims(): never {
  throw new InvalidAccessTokenError(AccessTokenFailureReason.INVALID_CLAIMS);
}

/**
 * The caller of a protected route, built only from an access token whose signature, issuer,
 * audience and lifetime were already verified. Immutable.
 */
export class AuthenticatedPrincipal {
  private constructor(
    /** User id, from `sub`. */
    readonly userId: string,
    /** Roles from the `roles` claim, de-duplicated and frozen. */
    readonly roles: readonly Role[],
    /** Customer id from `customerId`; `null` when the claim is absent (admins). */
    readonly customerId: string | null,
  ) {
    Object.freeze(this);
  }

  /**
   * Builds the principal from verified token claims.
   *
   * @param claims The verified JWT payload.
   * @returns The principal.
   * @throws InvalidAccessTokenError `INVALID_CLAIMS` when the payload is not an object, `sub` is
   * missing or empty, `roles` is not a non-empty array of known roles, or `customerId` is present
   * but not a non-empty string.
   */
  static fromClaims(claims: unknown): AuthenticatedPrincipal {
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
      invalidClaims();
    }
    const { sub, roles, customerId } = claims as Record<string, unknown>;
    if (!isNonEmptyString(sub)) {
      invalidClaims();
    }
    if (!Array.isArray(roles) || roles.length === 0 || !roles.every(isRole)) {
      invalidClaims();
    }
    if (customerId !== undefined && !isNonEmptyString(customerId)) {
      invalidClaims();
    }
    const uniqueRoles = Object.freeze([...new Set<Role>(roles)]);
    return new AuthenticatedPrincipal(sub, uniqueRoles, customerId ?? null);
  }

  /**
   * Tells whether the principal holds at least one of the allowed roles.
   *
   * @param allowed The roles a route accepts.
   * @returns `true` when the two role lists overlap.
   */
  hasAnyRole(allowed: readonly Role[]): boolean {
    return allowed.some((role) => this.roles.includes(role));
  }
}
