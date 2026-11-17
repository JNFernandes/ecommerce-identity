# Feature Specification: Publish the signing keys (JWKS) and support key rotation (US-03)

**Feature Branch**: `feature/US-03-jwks-key-rotation`

**Created**: 2026-11-17

**Status**: Draft

**Input**: User description: "US-03: Publish the public signing keys (JWKS) and support key
rotation. Public GET /.well-known/jwks.json returning {keys: [...]} with kty RSA, use sig, alg
RS256, kid, n, e and no private material. Key set: one active signing key (JWT_PRIVATE_KEY_PATH)
plus zero or more retired public keys (JWT_RETIRED_PUBLIC_KEY_PATHS, comma separated); all
published; kid is the RFC 7638 thumbprint. Fail fast at startup if a key does not parse, two keys
share a kid, or a retired file holds private material. `npm run keys:generate` takes an output name
and never overwrites without an explicit flag; README rotation runbook. Cache-Control public with
max-age from JWKS_CACHE_SECONDS (default 300), ETag and 304. Exempt from rate limiting, works
without Kafka. Verification contract (RS256 only, key by kid, iss/aud/exp, refetch at most once per
minute on unknown kid) documented and proven by a reference verifier in the tests. Out of scope:
automatic rotation, vault/KMS, OpenID Connect discovery, other algorithms."

## Clarifications

### Session 2026-11-17

- Q: Where do retired keys come from? → A: PEM file paths listed in the env var
  `JWT_RETIRED_PUBLIC_KEY_PATHS`.
- Q: How is `kid` derived? → A: RFC 7638 JWK thumbprint of the public key.
- Q: How is the `ETag` computed? → A: Hash of the serialized key set (the exact response body).
- Q: Publish an OpenID Connect discovery document? → A: No.
- Q: Automate key rotation? → A: No; rotation stays manual, documented in the README runbook.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Services fetch the public keys and verify tokens offline (Priority: P1)

Another service (orders, catalog, ...) fetches the key set once, caches it, and verifies every
access token issued by Identity locally, without calling Identity per request.

**Why this priority**: Without published keys no other service can trust an access token; this is
the reason the endpoint exists and what the constitution requires.

**Independent Test**: With only the active key configured, log in, fetch the key set, and verify
the access token with the reference verifier using only the fetched keys.

**Acceptance Scenarios**:

1. **Given** the service is running with an active key, **When** an anonymous client requests
   `GET /.well-known/jwks.json`, **Then** the response is 200 JSON `{"keys": [...]}` containing one
   entry with exactly `kty` `"RSA"`, `use` `"sig"`, `alg` `"RS256"`, `kid`, `n` and `e`.
2. **Given** that entry, **When** its `kid` is compared with the `kid` header of an access token
   from `POST /auth/login`, **Then** they are equal and the token's signature verifies with `n`/`e`.
3. **Given** any key set, **When** the response is inspected, **Then** no entry contains private
   parameters (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`) or any other member than the six above.
4. **Given** a request carrying an `Authorization` header (valid, invalid or expired), **When** the
   key set is requested, **Then** it is still 200; the header is ignored.
5. **Given** Kafka is unreachable, **When** the key set is requested, **Then** it is 200 as usual.

---

### User Story 2 - Rotate the signing key without breaking live tokens (Priority: P1)

An operator replaces the signing key. Tokens signed with the previous key keep verifying until they
expire; new tokens are signed with the new key.

**Why this priority**: A leaked or aged key must be replaceable without logging every user out or
breaking every downstream service; the constitution requires more than one published key.

**Independent Test**: Issue a token with key A, restart with key B active and A's public key
retired, then verify the old token and a new token with the reference verifier.

**Acceptance Scenarios**:

1. **Given** key B active and key A's public key in the retired list, **When** the key set is
   requested, **Then** it lists B first, then A, each with its own thumbprint `kid`.
2. **Given** that configuration, **When** a user logs in, **Then** the new access token's `kid` is
   B's, and a token signed earlier with A (not yet expired) still verifies.
3. **Given** A is then removed from the retired list and the service restarted, **When** the key
   set is requested, **Then** only B is listed and tokens signed with A no longer verify.
4. **Given** several retired keys, **When** the key set is requested, **Then** all are listed, in
   the configured order, after the active key.
5. **Given** a developer runs `npm run keys:generate -- --name next`, **When** it completes,
   **Then** a new key pair is written under `keys/` with that name and the existing default pair is
   untouched; running it again with the same name fails without changing any file unless
   `--force` is given.
6. **Given** the README, **When** an operator follows the rotation runbook, **Then** it covers:
   generate a new pair, make it the active key, put the previous public key in the retired list,
   restart, and remove the retired key only after the access token lifetime has passed.

---

### User Story 3 - Unsafe key configuration stops startup (Priority: P2)

A misconfigured key set is rejected at startup with a clear message instead of silently publishing
the wrong keys or leaking private material.

**Why this priority**: A bad key set either breaks verification for every service or exposes a
private key; failing fast makes the mistake visible before any token is issued.

**Independent Test**: Boot the application with each invalid configuration below and check it
refuses to start with a message naming the problem and the offending file.

**Acceptance Scenarios**:

1. **Given** a retired path that does not exist or does not hold a parseable PEM key, **When** the
   service starts, **Then** startup fails naming the file.
2. **Given** a retired file that contains a private key, **When** the service starts, **Then**
   startup fails stating that retired keys must be public only; the private material is never
   loaded into the key set or logged.
3. **Given** the active key's public key also listed as retired, or two retired files with the same
   key, **When** the service starts, **Then** startup fails reporting the duplicate `kid` and both
   files.
4. **Given** a retired key that is not RSA or is shorter than 2048 bits, **When** the service
   starts, **Then** startup fails naming the file.
5. **Given** `JWKS_CACHE_SECONDS` that is not a non-negative integer, **When** the service starts,
   **Then** startup fails naming the variable.
6. **Given** no retired keys configured (unset or empty), **When** the service starts, **Then** it
   starts and publishes the active key only.

---

### User Story 4 - Clients cache the key set cheaply (Priority: P2)

Downstream services cache the key set and revalidate it cheaply, so the endpoint is not a hot path.

**Why this priority**: The endpoint is unthrottled; caching keeps its load low and lets verifiers
keep working through short Identity outages.

**Independent Test**: Fetch the key set, check the caching headers, then repeat with
`If-None-Match` set to the returned `ETag`.

**Acceptance Scenarios**:

1. **Given** default configuration, **When** the key set is fetched, **Then** the response has
   `Cache-Control: public, max-age=300` and an `ETag`.
2. **Given** `JWKS_CACHE_SECONDS=60`, **When** the key set is fetched, **Then** `max-age=60`.
3. **Given** a request with `If-None-Match` equal to the current `ETag`, **When** it is served,
   **Then** the response is 304 with no body and the same `Cache-Control` and `ETag`.
4. **Given** a stale or unrelated `If-None-Match`, **When** it is served, **Then** the response is
   200 with the full key set.
5. **Given** the same key set across restarts or instances, **When** it is fetched, **Then** the
   `ETag` is identical; **Given** a different key set, **Then** the `ETag` differs.
6. **Given** many rapid requests from one client, well above the login limit, **When** they are
   served, **Then** none is rejected with 429.

---

### User Story 5 - A documented verification contract proven by a reference verifier (Priority: P3)

Teams building other services know exactly how to verify tokens safely, and the tests prove the
contract against the real endpoint.

**Why this priority**: Verifiers that accept `none`, HS256 or unknown issuers would undo the
security of the whole platform; a tested reference removes guesswork.

**Independent Test**: Run the reference verifier from the tests against tokens from the real login
endpoint and against forged tokens.

**Acceptance Scenarios**:

1. **Given** a valid access token, **When** the reference verifier checks it, **Then** it accepts it
   by selecting the published key whose `kid` matches the token header.
2. **Given** a token with `alg` `none`, or HS256 signed using the public key as the HMAC secret,
   **When** it is verified, **Then** it is rejected.
3. **Given** a token with the wrong `iss`, the wrong `aud`, an `exp` in the past, a missing `kid`,
   or an altered payload, **When** it is verified, **Then** it is rejected.
4. **Given** a token with an unknown `kid`, **When** it is verified, **Then** the verifier refetches
   the key set once and rejects the token if the `kid` is still unknown; a second unknown `kid`
   within 60 seconds of that refetch is rejected without another fetch. The initial load of the
   key set does not count as a refetch.
5. **Given** the verifier has cached the old key set and the service has rotated to a new key,
   **When** a token signed with the new key arrives, **Then** the verifier refetches, finds the new
   `kid` and accepts the token.
6. **Given** the README, **When** a developer reads the verification section, **Then** it states:
   accept RS256 only, select the key by `kid`, check `iss`, `aud` and `exp`, and refetch at most
   once per minute on an unknown `kid`.

---

### Edge Cases

- Retired list with blanks, spaces or trailing commas (`a.pem, ,b.pem,`): empty entries are ignored,
  surrounding spaces trimmed.
- Retired file holding a private key whose public half is a valid key: still rejected (no silent
  extraction of the public part).
- A retired path pointing to the active key's private file: rejected as private material.
- Retired file holding several PEM blocks or a certificate: rejected; one public key per file.
- `If-None-Match: *` or a list containing the current `ETag`: treated as a match (304).
- `HEAD /.well-known/jwks.json`: same headers as GET, no body.
- Methods other than GET/HEAD on the path: not served (standard 404/405, no key data).
- `JWKS_CACHE_SECONDS=0`: allowed; `max-age=0` so clients revalidate every time.
- Database unreachable: the key set is still served; it depends on no storage.
- `keys:generate --name` with path separators or other unsafe characters: rejected without writing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST serve `GET /.well-known/jwks.json` (and `HEAD`) without authentication
  and declare it public, returning 200 JSON `{"keys": [...]}`.
- **FR-002**: Each entry MUST contain exactly `kty` `"RSA"`, `use` `"sig"`, `alg` `"RS256"`,
  `kid`, `n`, `e` (base64url) and MUST NEVER contain private parameters.
- **FR-003**: The key set MUST be the active signing key (from `JWT_PRIVATE_KEY_PATH`, as in US-02)
  first, followed by every key in `JWT_RETIRED_PUBLIC_KEY_PATHS` in configured order.
- **FR-004**: Each `kid` MUST be the RFC 7638 thumbprint of the public key, identical to the `kid`
  used when signing (US-02).
- **FR-005**: Only the active key MUST sign new tokens; retired keys are published for verification
  only.
- **FR-006**: `JWT_RETIRED_PUBLIC_KEY_PATHS` MUST be an optional, comma-separated list of PEM file
  paths, with empty entries ignored and whitespace trimmed. Retired keys have no other source.
- **FR-007**: Startup MUST fail with a clear message naming the file or variable when a retired
  file is missing or unparseable, holds private material, holds more than one key, is not an RSA
  key of at least 2048 bits, or when two keys share a `kid`.
- **FR-008**: Startup failure messages and logs MUST NEVER include key material.
- **FR-009**: The response MUST carry `Cache-Control: public, max-age=<JWKS_CACHE_SECONDS>`
  (default 300, non-negative integer, invalid value fails startup) and a strong `ETag` that is a
  hash of the serialized key set (the exact response body), computed once at startup.
- **FR-010**: A request whose `If-None-Match` matches the current `ETag` (or is `*`) MUST return
  304 with no body and the same `Cache-Control` and `ETag`.
- **FR-011**: The endpoint MUST be exempt from rate limiting and MUST NOT depend on Kafka or the
  database.
- **FR-012**: The endpoint MUST be documented in Swagger, including the response schema and the
  304 response.
- **FR-013**: `npm run keys:generate` MUST accept an optional `--name <name>` (letters, digits,
  `-`, `_`) writing that key pair under `keys/`; without it the current default files are used.
- **FR-014**: `keys:generate` MUST refuse to overwrite either file of an existing pair unless
  `--force` is given, and MUST write nothing when it refuses.
- **FR-015**: The README MUST document the rotation runbook (User Story 2, scenario 6), the new
  settings, and the verification contract (User Story 5, scenario 6).
- **FR-016**: The test suite MUST include a reference verifier that implements the verification
  contract and is exercised against tokens issued by the running service, including rotation and
  forged tokens.

### Key Entities

- **Signing key (active)**: the RSA private key that signs new access tokens; its public part is
  published. Exactly one.
- **Retired public key**: an RSA public key no longer used to sign, published so tokens it signed
  keep verifying until they expire. Zero or more.
- **Key set (JWKS)**: the published list of public keys, active first; fixed for the lifetime of a
  process and identified by its `ETag`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A downstream service verifies 100% of valid access tokens using only the published
  key set, with no per-request call to Identity.
- **SC-002**: During a rotation done per the runbook, 0 unexpired tokens signed with the previous
  key fail verification.
- **SC-003**: 100% of the invalid key configurations listed in User Story 3 prevent startup with a
  message that names the offending file or variable.
- **SC-004**: 0 private key parameters appear in any key set response, log line or startup error.
- **SC-005**: A revalidation with a current `ETag` transfers no key data (304, empty body).
- **SC-006**: The reference verifier rejects 100% of the forged tokens in User Story 5.
- **SC-007**: The key set is served normally with Kafka down and under request bursts that would
  exceed the login rate limit.
- **SC-008**: An operator can complete a rotation using only the README.

## Assumptions

- Keys are loaded once at startup; changing the key set requires a restart (no hot reload).
- Retired files hold a single public key in PEM form (SPKI `PUBLIC KEY`, or PKCS#1 `RSA PUBLIC
  KEY`); certificates are not accepted.
- The 2048-bit minimum and RSA-only rule from US-02 apply to retired keys too.
- `--name next` writes `keys/next-private.pem` and `keys/next-public.pem`; both are git-ignored.
- The `ETag` is a strong validator computed from the serialized key set, so equal key sets give
  equal `ETag`s on every instance.
- The reference verifier lives in the tests only; downstream services are not changed by this
  story.
- The endpoint is called server to server, so the existing CORS policy is unchanged.
- No clock-skew tolerance is part of the contract; downstream services may add a small one.
- Operators are responsible for removing a retired key only after the access token lifetime
  (default 15 minutes) has passed; removing it earlier invalidates the tokens it signed.
- Out of scope: automatic rotation, vault or KMS key storage, OpenID Connect discovery, keys for
  other algorithms, and publishing a key's activation or expiry dates.
