# Research: Publish the signing keys (JWKS) and support key rotation (US-03)

The spec's clarification session left no `NEEDS CLARIFICATION`. Each entry gives the decision and its reason.

## R1. `KeyRing` replaces `loadSigningKey` as the one key loader
`src/infra/security/key-ring.ts`: `loadKeyRing({ activePrivateKeyPath, retiredPublicKeyPaths })` reads the files and calls the pure `buildKeyRing(active, retired)` on `{ path, pem }` inputs. One loader means one place that validates, fails fast and derives `kid`s.

## R2. `SigningKey` stays the issuer's DI token, provided from the ring
`AppModule` provides `KeyRing` with an async factory and `SigningKey` with `useFactory: (ring) => ring.activeKey`. `JoseTokenIssuer` is unchanged, so the token format (header, claims, `kid`) stays byte-compatible with US-02.

## R3. Active key parsing reused from US-02
The active key keeps the US-02 rules (PKCS#8/PKCS#1 private PEM, RSA, ≥ 2048 bits, RFC 7638 SHA-256 `kid`); the helper moves into the ring. `SigningKeyError` is kept for every key error so US-02 messages and tests stay valid.

## R4. Retired keys: PEM label check before parsing
Each retired file must contain exactly one PEM block labelled `PUBLIC KEY` or `RSA PUBLIC KEY`. Any `PRIVATE` label fails with "retired keys must be public only"; a certificate, several blocks or no block fails as unparseable. Checking the label first stops `createPublicKey` from silently deriving the public half of a private key (spec edge case).

## R5. Retired key checks then `kid` uniqueness
After `createPublicKey`: RSA only, ≥ 2048 bits, `kid` = thumbprint. A `Map<kid, path>` across active + retired reports a duplicate with both file names. Messages name the file or variable, never content (FR-008).

## R6. JWK built from an allowlist
Each entry is built as `{ kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e }` from `exportJWK(publicKey)`; no spread. Private members can never leak, and the fixed member order makes the body deterministic.

## R7. Body and `ETag` computed once in the ring
`jwksJson = JSON.stringify({ keys })` (active first, then retired in configured order); `etag = '"' + base64url(sha256(jwksJson)) + '"'` (strong). Same keys give the same `ETag` on every instance and restart (US-4 #5).

## R8. `PublicKeySet` port + thin `JwksService`
Port `PublicKeySet { json, etag }` in `src/services/ports/`, implemented by `KeyRing`. `JwksService.current()` returns `{ body, etag, cacheControl }`. This keeps Controller → Service → infra; no domain logic exists in this story.

## R9. Controller sends the precomputed body
`JwksController` (`@Controller('.well-known')`, `@Get('jwks.json')`) uses `@Res()` and writes `jwksJson` with `Content-Type: application/json`, so the bytes hashed are the bytes sent. Express answers `HEAD` on the GET route with the same headers and no body.

## R10. `If-None-Match` handled explicitly
Pure helper `ifNoneMatchMatches(header, etag)` in `src/controllers/`: `*` matches; otherwise split on commas, trim, strip `W/`, compare (RFC 9110 weak comparison). A match returns 304 with `Cache-Control` and `ETag` and no body. Explicit rather than relying on Express `req.fresh`, which ignores a request `Cache-Control: no-cache`.

## R11. No throttling, no auth, no storage
The throttler is applied per route (`@UseGuards(ThrottlerGuard)` on auth only), so the JWKS route simply has none; `@SkipThrottle()` is added defensively for a future global guard. No auth guards exist yet; the controller JSDoc marks it public. It injects nothing that touches Kafka or PostgreSQL (FR-011).

## R12. `JWKS_CACHE_SECONDS` parsed strictly
New `parseNonNegativeInteger(raw, fallback, name)` throws `"<name> must be a non-negative integer"`; called in the `JwksService` provider factory so startup fails like the issuer checks. The existing `parseInteger` falls back silently, which the spec forbids here.

## R13. `JWT_RETIRED_PUBLIC_KEY_PATHS` via the existing `parseList`
`jwt.retiredPublicKeyPaths: string[]` in `configuration.ts`; `parseList` already trims and drops empty entries (spec edge case).

## R14. `keys:generate --name <name> [--force]`
`node:util.parseArgs` (strict, unknown flags fail). Name must match `^[A-Za-z0-9_-]+$` and writes `keys/<name>-private.pem` + `keys/<name>-public.pem`; no name keeps `private.pem`/`public.pem`. The existing check-both-files-before-writing logic covers "refuse and write nothing" (FR-014).

## R15. Reference verifier: custom wrapper over `createLocalJWKSet`
`tests/support/reference-verifier.ts`: `jwtVerify(token, getKey, { algorithms: ['RS256'], issuer, audience })`; rejects a missing `kid` before lookup; on `JWKSNoMatchingKey` refetches once unless a refetch already happened in the last 60 s (the initial load does not count, so a rotation right after the first fetch is still picked up) (injected clock and fetch, fetch count exposed). `createRemoteJWKSet` hides fetches and timing, so the "at most once per minute" rule could not be asserted.

## R16. Forged tokens built with jose
`alg: none` via `UnsecuredJWT`; HS256 via `SignJWT` with the public PEM bytes as secret; unknown key via a fresh RSA pair. Wrong `iss`/`aud`/past `exp`/altered payload are signed with the real test key.

## R17. Test split
Unit: `buildKeyRing` (valid set, duplicate `kid`, private in retired, unparsable, missing active, non-RSA/short key), JWK allowlist, `ETag` stability, `ifNoneMatchMatches`, config parser, `JwksService`, `keys:generate` name/force, verifier. Integration (temp files, no containers): `loadKeyRing` from real files incl. missing/unreadable paths. Component: response shape, cache headers, 304/HEAD, Authorization ignored, Kafka down, bursts without 429, startup failures, rotation across restarts.

## R18. ADR 0001 gets a note, no new ADR
The approach is unchanged (RS256 + JWKS by `kid`). The note records that "several active keys" is realised as one signing key plus verify-only retired public keys, configured by file paths and rotated manually.
