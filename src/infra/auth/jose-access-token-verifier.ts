import { errors, importJWK, JWTPayload, jwtVerify, KeyLike, ProtectedHeaderParameters } from 'jose';
import { AuthenticatedPrincipal } from '../../domain/authenticated-principal';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../domain/errors/invalid-access-token.error';
import { AccessTokenVerifier } from '../../services/ports/access-token-verifier';
import { Clock } from '../../services/ports/clock';
import { PublicJwk } from '../security/key-ring';

/** The only accepted signature algorithm. */
const ALGORITHM = 'RS256';

/** Claims every access token must carry, on top of the issuer and audience. */
const REQUIRED_CLAIMS = ['sub', 'iat', 'exp', 'jti'];

/** Settings of {@link JoseAccessTokenVerifier}. */
export interface JoseAccessTokenVerifierOptions {
  /** Expected `iss` (`JWT_ISSUER`). */
  issuer: string;
  /** Expected `aud` (`JWT_AUDIENCE`). */
  audience: string;
  /** Allowed clock skew in seconds for `exp`, `iat` and `nbf` (`JWT_CLOCK_TOLERANCE_SECONDS`). */
  clockToleranceSeconds: number;
}

/** Throws the generic access token error with the given reason. */
function reject(reason: AccessTokenFailureReason): never {
  throw new InvalidAccessTokenError(reason);
}

/** Maps a jose claim validation failure to its reason. */
function claimFailureReason(error: errors.JWTClaimValidationFailed): AccessTokenFailureReason {
  if (error.claim === 'iss' || error.claim === 'aud') {
    return AccessTokenFailureReason.CLAIM_MISMATCH;
  }
  if ((error.claim === 'nbf' || error.claim === 'iat') && error.reason === 'check_failed') {
    return AccessTokenFailureReason.NOT_YET_VALID;
  }
  return AccessTokenFailureReason.INVALID_CLAIMS;
}

/**
 * Maps any error raised while verifying to the generic access token error. Token input is
 * attacker-controlled, so an unexpected error is still a refused token, never a 5xx.
 */
function toInvalidAccessTokenError(error: unknown): InvalidAccessTokenError {
  if (error instanceof InvalidAccessTokenError) {
    return error;
  }
  if (error instanceof errors.JWTExpired) {
    return new InvalidAccessTokenError(AccessTokenFailureReason.EXPIRED);
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return new InvalidAccessTokenError(claimFailureReason(error));
  }
  if (error instanceof errors.JOSEAlgNotAllowed) {
    return new InvalidAccessTokenError(AccessTokenFailureReason.UNSUPPORTED_ALGORITHM);
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return new InvalidAccessTokenError(AccessTokenFailureReason.INVALID_SIGNATURE);
  }
  return new InvalidAccessTokenError(AccessTokenFailureReason.MALFORMED_TOKEN);
}

/**
 * `AccessTokenVerifier` over the key ring. Every published key (active and retired) is imported
 * once at startup and looked up by `kid`, so a verification makes no network call or file read.
 * Only RS256 is accepted; `iss`, `aud`, `exp`, `nbf` and a future `iat` are checked with the
 * configured clock tolerance.
 */
export class JoseAccessTokenVerifier extends AccessTokenVerifier {
  /**
   * @param keys The published public keys by `kid`.
   * @param options Expected issuer, audience and clock tolerance.
   * @param clock Source of the current time.
   */
  constructor(
    private readonly keys: ReadonlyMap<string, KeyLike>,
    private readonly options: JoseAccessTokenVerifierOptions,
    private readonly clock: Clock,
  ) {
    super();
  }

  /**
   * Imports every published key once and builds the verifier.
   *
   * @param jwks The key ring's public JWKs (active and retired).
   * @param options Expected issuer, audience and clock tolerance.
   * @param clock Source of the current time.
   */
  static async create(
    jwks: readonly PublicJwk[],
    options: JoseAccessTokenVerifierOptions,
    clock: Clock,
  ): Promise<JoseAccessTokenVerifier> {
    const keys = new Map<string, KeyLike>();
    for (const jwk of jwks) {
      keys.set(jwk.kid, (await importJWK({ ...jwk }, ALGORITHM)) as KeyLike);
    }
    return new JoseAccessTokenVerifier(keys, options, clock);
  }

  /**
   * Verifies the token and builds its principal.
   *
   * @param token The compact JWS. Never logged or put in an error.
   * @throws InvalidAccessTokenError For every refused token, with the reason for the logs.
   */
  async verify(token: string): Promise<AuthenticatedPrincipal> {
    const now = this.clock.now();
    const tolerance = this.options.clockToleranceSeconds;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, (header) => this.keyFor(header), {
        algorithms: [ALGORITHM],
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: tolerance,
        requiredClaims: REQUIRED_CLAIMS,
        currentDate: now,
      }));
    } catch (error) {
      throw toInvalidAccessTokenError(error);
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (typeof payload.iat !== 'number') {
      reject(AccessTokenFailureReason.INVALID_CLAIMS);
    }
    // jose checks `iat` only with `maxTokenAge`, so a token issued in the future is refused here.
    if (payload.iat > nowSeconds + tolerance) {
      reject(AccessTokenFailureReason.NOT_YET_VALID);
    }
    return AuthenticatedPrincipal.fromClaims(payload);
  }

  /** Resolves the verification key from the `kid` header. */
  private keyFor(header: ProtectedHeaderParameters): KeyLike {
    const key = header.kid === undefined ? undefined : this.keys.get(header.kid);
    if (key === undefined) {
      reject(AccessTokenFailureReason.UNKNOWN_KEY);
    }
    return key;
  }
}
