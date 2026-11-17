import {
  createLocalJWKSet,
  decodeProtectedHeader,
  JSONWebKeySet,
  JWTPayload,
  jwtVerify,
} from 'jose';

/** Minimum time between two key set refetches triggered by an unknown `kid`, in milliseconds. */
export const REFETCH_INTERVAL_MS = 60_000;

/** A token the reference verifier refuses before signature verification. */
export class TokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

/** Settings and collaborators of {@link ReferenceVerifier}. */
export interface ReferenceVerifierOptions {
  /** Expected `iss`. */
  issuer: string;
  /** Expected `aud`. */
  audience: string;
  /** Fetches the key set, e.g. `GET /.well-known/jwks.json`. */
  fetchKeySet: () => Promise<JSONWebKeySet>;
  /** Current time in milliseconds since the epoch; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Reference implementation of `contracts/verification-contract.md`: how a downstream service
 * verifies Identity access tokens offline. RS256 only, key selected by `kid` (never by trying
 * every key), `iss`/`aud`/`exp` checked, and an unknown `kid` refetches the key set at most once
 * per {@link REFETCH_INTERVAL_MS}, counted from the previous refetch (the initial load does not
 * count).
 */
export class ReferenceVerifier {
  private keySet: JSONWebKeySet | undefined;
  private lastRefetchAt: number | undefined;
  private fetches = 0;
  private readonly now: () => number;

  constructor(private readonly options: ReferenceVerifierOptions) {
    this.now = options.now ?? Date.now;
  }

  /** How many times the key set was fetched, initial load included. */
  get fetchCount(): number {
    return this.fetches;
  }

  /**
   * Verifies a token and returns its claims.
   *
   * @param token The compact JWS.
   * @returns The verified payload; take `sub`, `customerId` and `roles` only from here.
   * @throws TokenRejectedError When the header has no `kid` or the `kid` stays unknown.
   * @throws Error (from jose) When the algorithm, signature, `iss`, `aud` or `exp` is wrong.
   */
  async verify(token: string): Promise<JWTPayload> {
    const { kid } = decodeProtectedHeader(token);
    if (kid === undefined || kid === '') {
      throw new TokenRejectedError('token has no kid');
    }
    const keySet = await this.keySetWith(kid);
    const { payload } = await jwtVerify(token, createLocalJWKSet(keySet), {
      algorithms: ['RS256'],
      issuer: this.options.issuer,
      audience: this.options.audience,
      currentDate: new Date(this.now()),
    });
    return payload;
  }

  /** Returns a key set holding `kid`, loading or refetching it under the once-per-minute rule. */
  private async keySetWith(kid: string): Promise<JSONWebKeySet> {
    if (this.keySet === undefined) {
      this.keySet = await this.fetch();
    }
    if (!hasKid(this.keySet, kid) && this.mayRefetch()) {
      this.lastRefetchAt = this.now();
      this.keySet = await this.fetch();
    }
    if (!hasKid(this.keySet, kid)) {
      throw new TokenRejectedError('unknown kid');
    }
    return this.keySet;
  }

  private mayRefetch(): boolean {
    return (
      this.lastRefetchAt === undefined || this.now() - this.lastRefetchAt >= REFETCH_INTERVAL_MS
    );
  }

  private async fetch(): Promise<JSONWebKeySet> {
    this.fetches += 1;
    return this.options.fetchKeySet();
  }
}

/** Whether the key set publishes a key with this `kid`. */
function hasKid(keySet: JSONWebKeySet, kid: string): boolean {
  return keySet.keys.some((key) => key.kid === kid);
}
