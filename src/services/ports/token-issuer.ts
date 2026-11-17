import { Role } from '../../domain/role.enum';

/** Who an access token is issued to. */
export interface AccessTokenSubject {
  /** User id; becomes `sub`. */
  userId: string;
  /** Customer id; becomes `customerId`, omitted when `null`. */
  customerId: string | null;
  /** Current roles; becomes `roles`. */
  roles: Role[];
}

/** A signed access token and its lifetime. */
export interface IssuedAccessToken {
  /** The compact JWS. Never logged. */
  token: string;
  /** Lifetime in seconds. */
  expiresIn: number;
}

/** Port for signing access tokens. Used as the Nest injection token. */
export abstract class TokenIssuer {
  /**
   * Issues a signed access token.
   *
   * @param subject The user the token is for.
   * @param issuedAt The issue time (`iat`); `exp` is derived from it.
   */
  abstract issue(subject: AccessTokenSubject, issuedAt: Date): Promise<IssuedAccessToken>;
}
