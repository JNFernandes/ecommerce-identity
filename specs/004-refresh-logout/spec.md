# Feature Specification: Refresh the session and log out (US-04)

**Feature Branch**: `feature/US-04-refresh-logout`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "US-04: Refresh the session and log out. POST /auth/refresh with
refreshToken returns a new accessToken and refreshToken (login response shape). POST /auth/logout
with refreshToken always returns 204 and revokes the whole family. Single-use tokens looked up by
SHA-256 hash, rotated in one transaction with a row lock; concurrent reuse loses. Reuse of a used or
revoked token revokes the family and returns 401; unknown, expired or non-ACTIVE user also return the
same 401 (non-ACTIVE also revokes the family). New access token built from current roles and
customerId. Absolute session limit JWT_SESSION_MAX_SECONDS (default 30 days); new refresh expiry =
min(now + JWT_REFRESH_TTL_SECONDS, session limit). Refresh rate limited (default 30/min per IP),
logout too. Issued access tokens stay valid after logout (README trade-off). No tokens in logs or
error bodies. Works without Kafka. Out of scope: logout from all devices, purging expired tokens,
reuse grace window, GET /users/me, admin session revocation."

## Clarifications

### Session 2026-11-18

- Q: Should reuse detection allow a grace window for a client retrying a refresh whose response was
  lost? → A: No. Strict detection: any second use revokes the family; the trade-off is documented.
- Q: Do refresh failures differ by cause (unknown, expired, reused, non-`ACTIVE` user)? → A: No. The
  same generic 401 (status and body) for every token or account failure.
- Q: What does logout return for unknown, expired, used or revoked tokens? → A: Always 204.
- Q: How is the absolute session lifetime set? → A: 30 days by default, from configuration
  (`JWT_SESSION_MAX_SECONDS`).
- Q: Is there a job that purges expired or revoked refresh tokens? → A: No purge job in this story.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep a session alive with a refresh token (Priority: P1)

A logged-in user whose access token is about to expire exchanges their refresh token for a new
access token and a new refresh token, without entering their password again.

**Why this priority**: Access tokens last 15 minutes; without refresh every user would have to log
in again four times an hour.

**Independent Test**: Log in, call refresh with the returned refresh token, and check the new
tokens, the stored state of the old and new refresh tokens, and that the old one no longer works.

**Acceptance Scenarios**:

1. **Given** a valid, unused refresh token of an active user, **When** it is presented to refresh,
   **Then** the response is 200 with exactly `accessToken`, `refreshToken`, `tokenType` `"Bearer"`
   and `expiresIn`, the same shape as login.
2. **Given** a successful refresh, **When** storage is inspected, **Then** the presented token is
   marked revoked at the refresh time and points to the new token as its replacement, and the new
   token is stored only as a hash in the same family.
3. **Given** a successful refresh, **When** the new access token is decoded, **Then** it carries the
   same claim set as a login token (`sub`, `customerId` for customers only, `roles`, `iss`, `aud`,
   `iat`, `exp`, a new `jti`, header `kid`), with `roles` and `customerId` read from the user's
   current record, not copied from the previous token.
4. **Given** a chain of successful refreshes, **When** each new refresh token is used in turn,
   **Then** each one succeeds exactly once.

---

### User Story 2 - Detect a stolen refresh token (Priority: P1)

If a refresh token is presented after it was already used or revoked, the system assumes it was
stolen, ends the whole session for every holder, and refuses the request.

**Why this priority**: Security First is non-negotiable; reuse detection is the main protection for
long-lived refresh tokens.

**Independent Test**: Refresh once, then present the original token again; check the 401 and that
the token issued by the first refresh no longer works either.

**Acceptance Scenarios**:

1. **Given** a refresh token that was already used, **When** it is presented again, **Then** the
   response is the generic 401 and every token in its family is revoked, including the one issued
   by the legitimate refresh.
2. **Given** a refresh token revoked by logout, **When** it is presented to refresh, **Then** the
   response is the generic 401 and the family stays revoked.
3. **Given** two refresh requests with the same valid token at the same moment, **When** both are
   processed, **Then** exactly one returns 200 and the other is treated as reuse: 401 and the family
   (including the token just issued) is revoked.

---

### User Story 3 - Refuse invalid refreshes without revealing why (Priority: P1)

Every refresh failure returns the same answer, so a caller learns nothing about the token or the
account.

**Why this priority**: Distinguishable failures would let an attacker probe token state or account
status.

**Independent Test**: Present an unknown token, an expired token, a token of a disabled user and a
reused token; compare the responses.

**Acceptance Scenarios**:

1. **Given** an unknown token, an expired token, a reused token, or a token of a user whose status
   is not `ACTIVE`, **When** it is presented to refresh, **Then** each response is 401 with an
   identical body and no new tokens are issued or stored.
2. **Given** a valid token of a user who is no longer `ACTIVE`, **When** it is presented, **Then**
   its whole family is also revoked.
3. **Given** an expired, never-used token, **When** it is presented, **Then** the response is 401
   and the family is not revoked.
4. **Given** a body with a missing or non-string `refreshToken`, malformed JSON or an unknown
   property, **When** it is submitted to refresh or logout, **Then** the response is 400 and no
   token is looked up.

---

### User Story 4 - Enforce an absolute session lifetime (Priority: P2)

A session started by a login cannot be kept alive forever by refreshing; after the maximum session
age the user must log in again.

**Why this priority**: Limits the damage of a stolen token that is refreshed regularly and bounds
how long a disabled credential chain can live.

**Independent Test**: With a short configured session limit, log in and refresh until the limit
passes; check the expiry of each new refresh token and the 401 afterwards.

**Acceptance Scenarios**:

1. **Given** a session started at login time T with maximum age M, **When** a refresh happens at
   time t, **Then** the new refresh token expires at the earlier of t + refresh lifetime and T + M.
2. **Given** a session older than its maximum age, **When** its latest token is presented, **Then**
   the response is the generic 401 (the token has already expired by construction).

---

### User Story 5 - Log out (Priority: P2)

A user ends their session by sending their refresh token; afterwards no token of that session can
be refreshed. The answer never reveals whether the token existed.

**Why this priority**: Users and client apps need a way to end a session on shared or lost
devices.

**Independent Test**: Log in, refresh once, log out with the latest token, then try to refresh with
it; log out with an unknown and an already-revoked token.

**Acceptance Scenarios**:

1. **Given** a valid refresh token, **When** it is sent to logout, **Then** the response is 204 and
   every token in its family is revoked.
2. **Given** an unknown, expired, already-used or already-revoked token, **When** it is sent to
   logout, **Then** the response is 204 with no body; for a known token the family is revoked.
3. **Given** a successful logout, **When** an access token issued earlier in that session is used
   at another service, **Then** it stays valid until it expires (documented trade-off).

---

### User Story 6 - Throttle refresh and logout (Priority: P3)

Refresh and logout requests are limited per client IP so they cannot be used to brute-force tokens
or load the database.

**Why this priority**: 256-bit tokens make guessing impractical, but throttling still limits abuse
and load.

**Independent Test**: Send more than the limit from one IP to each endpoint and check the 429s.

**Acceptance Scenarios**:

1. **Given** the refresh limit (default 30 per minute), **When** a 31st refresh request from the
   same IP arrives within the minute, **Then** the response is 429 and no token is looked up.
2. **Given** the logout limit, **When** it is exceeded from one IP, **Then** the response is 429.

### Edge Cases

- A token that is both expired and already used/revoked is treated as reuse (family revoked).
- Logout of a family that is already revoked: 204, nothing changes.
- A user disabled between two refreshes: the next refresh gets 401 and the family is revoked;
  access tokens already issued stay valid until they expire.
- A role change between refreshes: the next access token carries the new roles.
- Database unavailable during refresh or logout: 5xx with no token issued, never a 401 or 204 that
  hides the failure.
- Kafka unreachable: refresh and logout are unaffected (they publish no events).
- A client retries a refresh after losing the first response: the retry is reuse, the family is
  revoked and the user must log in again (no grace window, by design).
- Tokens, token hashes and `Authorization` headers never appear in logs or error bodies, also for
  400, 401 and 429 responses.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose public `POST /auth/refresh` and `POST /auth/logout`, each
  accepting exactly one string field `refreshToken`; anything else is 400.
- **FR-002**: A presented refresh token MUST be looked up only by its SHA-256 hash.
- **FR-003**: A successful refresh MUST, in a single transaction, mark the presented token revoked
  (revocation time, replaced-by = new token id) and store a new token (≥256 bits, hash only) in the
  same family; if the transaction fails, nothing changes and no tokens are returned.
- **FR-004**: Two concurrent refreshes with the same token MUST NOT both succeed; the loser MUST be
  handled as reuse (FR-005).
- **FR-005**: Presenting a token that is already revoked (used, logged out or family-revoked) MUST
  revoke every token of its family and return the generic 401.
- **FR-006**: Unknown token, expired token and non-`ACTIVE` user MUST return the same generic 401
  as reuse (identical status and body); a non-`ACTIVE` user MUST additionally have the family
  revoked. An expired, unused token does not revoke the family.
- **FR-007**: The refresh response MUST have the login shape (`accessToken`, `refreshToken`,
  `tokenType` `"Bearer"`, `expiresIn`); the access token MUST be built from the user's current
  `roles` and `customerId` with the same claims and lifetime rules as login.
- **FR-008**: Each family MUST have an absolute limit = session start (the login that created it) +
  `JWT_SESSION_MAX_SECONDS` (default 2592000). A new refresh token MUST expire at the earlier of
  now + `JWT_REFRESH_TTL_SECONDS` and that limit.
- **FR-009**: Logout MUST always return 204 with no body for any well-formed request, and MUST
  revoke every not-yet-revoked token in the presented token's family when the token is known.
- **FR-010**: Refresh MUST be rate limited per client IP (configurable, default 30 per minute) and
  logout per client IP (configurable, default 30 per minute); excess returns 429.
- **FR-011**: Refreshes, reuse detections (with family id and user id) and logouts MUST be logged
  without token values, token hashes or `Authorization` headers; the 401 reason may be logged but
  never returned.
- **FR-012**: Refresh and logout MUST work when Kafka is unreachable.
- **FR-013**: The README MUST state that access tokens issued before a logout stay valid until they
  expire, and that reuse detection is strict (no grace window: a retried refresh revokes the
  session).
- **FR-015**: `JWT_SESSION_MAX_SECONDS` MUST be read from configuration (default 2592000 = 30 days)
  and listed in `.env.example`.
- **FR-016**: Expired and revoked refresh tokens MUST remain stored; this story adds no purge job.
- **FR-014**: Both endpoints MUST be documented in Swagger, including 400, 401 (refresh), 429 and
  204 (logout) responses.

### Key Entities

- **Refresh token** (existing from US-02): id, user, family id, token hash (unique), created,
  expires, revoked at, replaced by. This story sets `revokedAt` and `replacedBy`.
- **Token family / session**: all refresh tokens descending from one login. Has a start time (the
  creation of its first token) and an absolute expiry; revoked as a whole on reuse, logout or an
  inactive user.
- **User** (existing): its current status, roles and `customerId` are read at every refresh.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An active user with a valid refresh token receives new usable tokens in a single
  request, answered in under 1 second under normal load.
- **SC-002**: 100% of refresh tokens succeed at most once; across 100 concurrent attempts with the
  same token, exactly one succeeds.
- **SC-003**: 100% of reuse attempts leave every token of the family unusable.
- **SC-004**: 100% of refresh failures (unknown, expired, reused, inactive user) return the same
  status and byte-identical body.
- **SC-005**: No session can be extended past its maximum age; 0 refresh tokens expire after their
  family's limit.
- **SC-006**: 100% of logout requests with a well-formed body return 204, whatever the token state.
- **SC-007**: 0 occurrences of a token, token hash or `Authorization` header in any log line or
  error body across the test suite.
- **SC-008**: With messaging unavailable, 100% of valid refreshes and logouts still succeed.

## Assumptions

- The session start is the creation time of the family's first refresh token (the login); it is
  derived from stored data, so no new column is strictly required (the plan decides).
- Refresh lifetime stays `JWT_REFRESH_TTL_SECONDS` (default 7 days, from US-02); the session limit
  must be at least that value, otherwise startup fails with a clear message.
- Rate limits are per client IP only (no email is known at refresh/logout); client IP rules as in
  US-01.
- The 401 body is the same generic shape as the login failure, with its own neutral message
  (e.g. "invalid refresh token"), identical for every refresh failure.
- Logout with a malformed body returns 400: it reveals nothing about any token.
- Logout needs no access token; possession of the refresh token is the proof.
- "Every refresh failure" and "logout always 204" cover token and account state; a malformed body
  (400), throttling (429) and a database outage (5xx) keep their own statuses.
- Out of scope: logout from all devices, purging expired tokens, a reuse grace window,
  `GET /users/me` (US-05), admin session revocation.
