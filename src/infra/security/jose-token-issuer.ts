import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  AccessTokenSubject,
  IssuedAccessToken,
  TokenIssuer,
} from '../../services/ports/token-issuer';
import { SigningKey } from './signing-key';

/** Settings of {@link JoseTokenIssuer}. */
export interface JoseTokenIssuerOptions {
  /** `iss` claim. */
  issuer: string;
  /** `aud` claim. */
  audience: string;
  /** Lifetime in seconds; `exp = iat + accessTtlSeconds`. */
  accessTtlSeconds: number;
}

/**
 * `TokenIssuer` that signs RS256 JWTs with jose. Header `{ alg: RS256, kid, typ: JWT }`; claims
 * exactly `sub`, `customerId` (only when set), `roles`, `iss`, `aud`, `iat`, `exp` and `jti`.
 */
export class JoseTokenIssuer extends TokenIssuer {
  /**
   * @param signingKey The private key and its `kid`.
   * @param options Issuer, audience and lifetime.
   */
  constructor(
    private readonly signingKey: SigningKey,
    private readonly options: JoseTokenIssuerOptions,
  ) {
    super();
  }

  /**
   * Signs an access token for the subject.
   *
   * @param subject The user the token is for.
   * @param issuedAt The issue time, truncated to whole seconds for `iat`.
   */
  async issue(subject: AccessTokenSubject, issuedAt: Date): Promise<IssuedAccessToken> {
    const iat = Math.floor(issuedAt.getTime() / 1000);
    const claims: { roles: string[]; customerId?: string } = { roles: [...subject.roles] };
    if (subject.customerId !== null) {
      claims.customerId = subject.customerId;
    }
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.signingKey.kid, typ: 'JWT' })
      .setSubject(subject.userId)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.options.accessTtlSeconds)
      .setJti(randomUUID())
      .sign(this.signingKey.privateKey);
    return { token, expiresIn: this.options.accessTtlSeconds };
  }
}
