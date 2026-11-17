import { PublicKeySet } from './ports/public-key-set';

/** Default `JWKS_CACHE_SECONDS`. */
export const DEFAULT_JWKS_CACHE_SECONDS = 300;

/** What the JWKS endpoint serves: the precomputed body and its caching headers. */
export interface JwksSnapshot {
  /** The serialized key set, sent as is. */
  body: string;
  /** Strong `ETag` of {@link body}. */
  etag: string;
  /** `public, max-age=<JWKS_CACHE_SECONDS>`. */
  cacheControl: string;
}

/**
 * Serves the published key set. Orchestration only: the body and `ETag` come precomputed from the
 * {@link PublicKeySet} port, so a request needs no crypto, I/O, Kafka or database.
 */
export class JwksService {
  private readonly snapshot: JwksSnapshot;

  /**
   * @param publicKeySet The published keys (the key ring).
   * @param cacheSeconds `max-age` for clients and caches; a non-negative integer.
   */
  constructor(publicKeySet: PublicKeySet, cacheSeconds: number) {
    this.snapshot = {
      body: publicKeySet.json,
      etag: publicKeySet.etag,
      cacheControl: `public, max-age=${cacheSeconds}`,
    };
  }

  /** The current key set and its caching headers; the same object for the life of the process. */
  current(): JwksSnapshot {
    return this.snapshot;
  }
}
