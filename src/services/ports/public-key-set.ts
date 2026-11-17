/**
 * Port for the published key set (JWKS). The service layer reads it; infra (`KeyRing`) implements
 * it. Both values are computed once at startup and never contain private key material.
 */
export abstract class PublicKeySet {
  /** The serialized key set, `{"keys":[...]}`: exactly the bytes served. */
  abstract readonly json: string;
  /** Strong `ETag` of {@link json}, quoted. Same keys give the same value on every instance. */
  abstract readonly etag: string;
}
