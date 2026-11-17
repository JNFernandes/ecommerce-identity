# Feature Specification: Log in with email and password (US-02)

**Feature Branch**: `feature/US-02-login-email-password`

**Created**: 2026-11-17

**Status**: Draft

**Input**: User description: "US-02: Log in with email and password. POST /auth/login returns 200
with accessToken, refreshToken, tokenType Bearer and expiresIn. Email normalized as in
registration; argon2id verification; one generic 401 for every failure with a dummy-hash check for
unknown emails; RS256 access token with kid and the constitutional claims; opaque ≥256-bit refresh
token stored only as a SHA-256 hash in a new family; signing key from a PEM file with RFC 7638 kid,
fail fast if missing, `npm run keys:generate` for development; rate limited by IP and by email;
lastLoginAt updated; no secrets in logs; works when Kafka is unreachable. Out of scope: refresh,
logout, JWKS, key rotation, GET /users/me, lockout, MFA."

## Clarifications

### Session 2026-11-17

- Q: Do all login failures, including disabled users, share one response? → A: Yes; every failure
  (unknown email, wrong password, non-`ACTIVE` user) returns the same generic 401 body.
- Q: What are the token lifetimes and where do they come from? → A: Access 15 min, refresh 7 days,
  both from configuration.
- Q: What keys does login throttling use? → A: Client IP and normalized email.
- Q: How is the JWT `kid` derived? → A: RFC 7638 thumbprint of the public key.
- Q: Is there account lockout after repeated failures? → A: No; throttling only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log in and receive tokens (Priority: P1)

A registered, active user submits their email and password and receives a short-lived access
token that other services can verify, plus a refresh token for later use (US-04).

**Why this priority**: Without login no user can act on the platform; every protected endpoint in
every service depends on the access token issued here.

**Independent Test**: Register a customer, log in, and check the 200 body, the access token's
header and claims, and that a hashed refresh token record exists.

**Acceptance Scenarios**:

1. **Given** an active customer `ana@example.com`, **When** they log in with ` Ana@Example.com ` and
   the right password, **Then** the response is 200 with `accessToken`, `refreshToken`,
   `tokenType` `"Bearer"` and `expiresIn` equal to the configured access lifetime (default 900).
2. **Given** a successful login, **When** the access token is decoded, **Then** its header has `alg`
   `RS256` and the `kid` of the signing key, and its claims are exactly `sub` (user id),
   `customerId`, `roles` `["CUSTOMER"]`, `iss`, `aud`, `iat`, `exp` (= `iat` + lifetime) and `jti`;
   the signature verifies with the public key.
3. **Given** a user with no `customerId`, **When** they log in, **Then** the access token has no
   `customerId` claim.
4. **Given** two successful logins by the same user, **When** the results are compared, **Then** the
   access tokens have different `jti` values, the refresh tokens differ, and each refresh token
   starts its own family.
5. **Given** a successful login, **When** storage is inspected, **Then** the refresh token exists
   only as a hash with user, family, creation and expiry (default 7 days) and is not revoked, and
   the user's `lastLoginAt` is set to the login time.

---

### User Story 2 - Refuse failed logins without revealing accounts (Priority: P1)

Any failed login gets the same answer, in about the same time, whatever the reason.

**Why this priority**: Security First is non-negotiable; distinguishable failures enable account
enumeration and targeted attacks.

**Independent Test**: Attempt login with an unknown email, a wrong password and a disabled user;
compare status codes, bodies and that no tokens or records are created.

**Acceptance Scenarios**:

1. **Given** an unknown email, a wrong password, or a user whose status is not `ACTIVE`, **When**
   they log in, **Then** each response is 401 with an identical body carrying the message
   "invalid credentials", no tokens are issued, no refresh token is stored and `lastLoginAt` is
   unchanged.
2. **Given** an unknown email, **When** a login is attempted, **Then** a password verification
   against a fixed dummy hash is still performed.
3. **Given** a body with a missing field, a non-string value, malformed JSON or an unknown
   property, **When** it is submitted, **Then** the response is 400 and no credential check is
   made.

---

### User Story 3 - Slow down credential stuffing (Priority: P2)

Login attempts are limited per client IP and per target email, so neither one source nor many
sources can hammer an account.

**Why this priority**: Rate limiting login is constitutional; keying on email too protects a single
account against distributed guessing.

**Independent Test**: Send more than the limit from one IP, then more than the limit for one email
across varied IPs, and check the 429s.

**Acceptance Scenarios**:

1. **Given** the per-minute limit (default 10), **When** an 11th login request from the same IP
   arrives within the minute, **Then** the response is 429 and no credential check is made.
2. **Given** the same limit, **When** an 11th login request for the same normalized email arrives
   within the minute from different IPs, **Then** the response is 429.
3. **Given** a limit has been reached, **When** the minute window has passed, **Then** login
   requests are processed again.

---

### User Story 4 - Operate the signing key safely (Priority: P2)

Operators provide the private key as a file; developers generate one with a single command. The
service refuses to start with a missing or invalid key.

**Why this priority**: Tokens cannot be issued without a key, and a silent misconfiguration would
only surface at the first login.

**Independent Test**: Start the service without a key, with an unreadable/invalid file, and with a
generated key; run the key generation command.

**Acceptance Scenarios**:

1. **Given** `JWT_PRIVATE_KEY_PATH` unset, pointing to a missing file, or to a file that is not a
   valid RSA private key, **When** the service starts, **Then** it exits with a clear message naming
   the problem and never printing key material.
2. **Given** a valid key, **When** the service starts, **Then** the `kid` is the RFC 7638 thumbprint
   of its public key, stable across restarts.
3. **Given** a fresh checkout, **When** a developer runs `npm run keys:generate`, **Then** a key pair
   is written to `./keys`, which is git-ignored, and the README documents the command.

### Edge Cases

- Email with surrounding spaces or upper case: normalized before lookup, like registration.
- Password is not trimmed: `"secret "` and `"secret"` are different passwords.
- Invalid email format or empty password: 400 (validation), since it reveals nothing about any
  account.
- User disabled after an access token was issued: that token stays valid until it expires
  (constitution III); new logins are refused with 401.
- Many failed attempts for one account: no lockout; the account is never blocked, only requests
  above the throttle limits get 429.
- Kafka unreachable: login is unaffected (it publishes no events).
- Database unavailable during login: 5xx with no token issued; never a 401.
- The refresh token is returned only in the login response and cannot be recovered afterwards.
- Logs and error bodies never include the password, hash, tokens or `Authorization` header, also
  for 400, 401 and 429 responses.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose public `POST /auth/login` accepting exactly `email` and
  `password` (strings); anything else is 400.
- **FR-002**: The email MUST be trimmed and lowercased exactly as in registration before lookup.
- **FR-003**: The password MUST be verified against the stored argon2id hash. For an unknown email
  the system MUST still verify against a fixed dummy hash.
- **FR-004**: Unknown email, wrong password and non-`ACTIVE` status MUST all return 401 with the
  same body ("invalid credentials"); the status check happens on the user's current state.
- **FR-005**: On success the response MUST be 200 with exactly `accessToken`, `refreshToken`,
  `tokenType` (`"Bearer"`) and `expiresIn` (seconds).
- **FR-006**: The access token MUST be an RS256-signed JWT whose header carries `alg` and `kid`, and
  whose claims are exactly `sub`, `customerId` (only when the user has one), `roles` (current roles),
  `iss` (`JWT_ISSUER`), `aud` (`JWT_AUDIENCE`), `iat`, `exp` and a unique `jti`. Lifetime is
  `JWT_ACCESS_TTL_SECONDS` (default 900).
- **FR-007**: The refresh token MUST be an opaque random value with at least 256 bits of entropy,
  returned once and stored only as a SHA-256 hash, with user id, a new family id, `createdAt` and
  `expiresAt` (`JWT_REFRESH_TTL_SECONDS`, default 604800).
- **FR-008**: A migration MUST create the `refresh_tokens` table (id, userId, familyId, tokenHash
  unique, createdAt, expiresAt, revokedAt, replacedBy) and add `lastLoginAt` to users if absent.
- **FR-009**: On success the user's `lastLoginAt` MUST be updated.
- **FR-010**: The private key MUST be loaded at startup from the PEM file at
  `JWT_PRIVATE_KEY_PATH`; `kid` is the RFC 7638 thumbprint of its public key. A missing or invalid
  key MUST stop startup with a clear message.
- **FR-011**: `npm run keys:generate` MUST create a development RSA key pair in `./keys`
  (git-ignored); the README MUST document it.
- **FR-012**: Login MUST be rate limited per client IP and per normalized email, each with a
  configurable requests-per-minute limit (default 10); excess returns 429.
- **FR-013**: Successful and failed logins MUST be logged (outcome, user id when known, client IP)
  without passwords, hashes, tokens or `Authorization` headers; the failure reason may be logged
  internally but never returned.
- **FR-014**: Login MUST work when Kafka is unreachable.

### Key Entities

- **Refresh token**: a long-lived credential. Id, user, family id, token hash (unique), created,
  expires, revoked (null here), replaced by (null here; used by US-04).
- **User** (existing): gains `lastLoginAt`; its status and roles are read at login.
- **Signing key**: the RSA private key and its `kid`, loaded once at startup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An active user with correct credentials receives usable tokens in a single request,
  answered in under 1 second under normal load.
- **SC-002**: 100% of failed logins (unknown email, wrong password, inactive user) return the same
  status and byte-identical body.
- **SC-003**: Median response time for an unknown email is within 20% of that for a known email
  with a wrong password.
- **SC-004**: 100% of issued access tokens verify with the service's public key and carry exactly
  the required claims; no two share a `jti`.
- **SC-005**: 0 occurrences of a password, hash, token or `Authorization` header in any response
  error body or log line across the test suite.
- **SC-006**: Per IP and per email, at most the configured number of attempts per minute (default
  10) are processed; the rest get 429.
- **SC-007**: With messaging unavailable, 100% of valid logins still succeed.

## Assumptions

- The per-IP and per-email limits share one configurable value (default 10/min); all requests
  count, not only failures. The email key is the normalized email.
- Client IP is the direct connection address unless a trusted proxy is configured (as in US-01).
- `JWT_ISSUER` and `JWT_AUDIENCE` are required; startup fails fast if unset, like the key.
- The dummy hash is computed once at startup with the configured argon2id parameters.
- No admin seed exists yet; admin login (no `customerId`) is covered by unit tests on token
  claims, and end-to-end once the seed story lands.
- Expired or old refresh tokens are not cleaned up in this story.
- Out of scope: refresh and logout (US-04), JWKS and key rotation (US-03), `GET /users/me` (US-05),
  account lockout, MFA.
