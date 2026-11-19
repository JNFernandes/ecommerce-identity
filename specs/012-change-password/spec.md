# Feature Specification: A user changes their own password (US-12)

**Feature Branch**: `feature/US-12-change-password`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-12: Change your own password. `POST /users/me/password` (CUSTOMER or
ADMIN) with currentPassword and newPassword. 200 with a new accessToken and refreshToken (login
shape) for the current session. Current password verified against the argon2id hash; wrong → 401
generic, rate limited (default 5/min keyed by user id and IP), excess 429. New password follows the
registration policy (10–128 chars, not the email) and differs from the current one, else 400. On
success, in one transaction: store the new hash, revoke every refresh token of the user, issue a new
pair for the caller. Existing access tokens stay valid until expiry (README trade-off). User re-read
from the database; non-ACTIVE → 401 as in US-05. No passwords, hashes or tokens in logs or
responses; change logged with the user id only. Works without Kafka; no event. Out of scope:
password reset by email, forced change at first login, password history, notifying the user."

## Clarifications

### Session 2026-11-19

- Q: How are "all other sessions" told apart from the current one, given the access token carries no
  refresh-token family (constitution TODO(CURRENT_SESSION))? → A: Revoke every refresh token of the
  user and issue a fresh pair to the caller; the caller's session continues on the new pair, every
  other session ends. Settles TODO(CURRENT_SESSION).
- Q: Is the endpoint rate limited (TODO(PASSWORD_CHANGE_RATE_LIMIT))? → A: Yes, default 5 attempts
  per minute keyed by user id and IP; excess returns 429. Settles the TODO.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Change my password and stay signed in (Priority: P1)

A signed-in customer or administrator gives their current password and a new one. The password is
replaced, they get a fresh token pair, and they keep working without logging in again.

**Why this priority**: The core value of the story: a user can replace a weak, leaked or
admin-supplied password (constitution II).

**Independent Test**: Log in, change the password, then log in with the new password (succeeds) and
the old one (fails); use the returned refresh token (succeeds).

**Acceptance Scenarios**:

1. **Given** an `ACTIVE` user with a valid access token, **When** they send the correct current
   password and a valid new one, **Then** the response is 200 with a new access token and refresh
   token in the login response shape.
2. **Given** that change, **When** the user logs in with the new password, **Then** login succeeds;
   with the old password, login fails with the generic login error.
3. **Given** the returned refresh token, **When** it is used, **Then** it rotates normally.
4. **Given** an administrator (including one created by the seed or `POST /users`), **When** they
   change their password, **Then** the same behaviour applies and their roles are unchanged.

---

### User Story 2 - Other sessions end (Priority: P1)

After a password change, every other device or session of the user must sign in again with the new
password.

**Why this priority**: A password change is often a reaction to a compromise; leaving other
sessions alive defeats it (constitution II).

**Independent Test**: Log in twice (two sessions), change the password from one, then try both
sessions' old refresh tokens and the newly returned one.

**Acceptance Scenarios**:

1. **Given** a user with several sessions, **When** the password is changed, **Then** every refresh
   token issued before the change is refused, including the one of the calling session.
2. **Given** the change, **When** the newly returned refresh token is used, **Then** it is accepted.
3. **Given** an access token issued before the change, **When** it is used, **Then** it keeps
   working until it expires (documented trade-off).

---

### User Story 3 - Wrong current password and guessing protection (Priority: P1)

**Why this priority**: The endpoint checks a password and is a guessing target for anyone holding a
stolen access token.

**Independent Test**: Send a wrong current password; repeat past the limit; check nothing changed.

**Acceptance Scenarios**:

1. **Given** a wrong current password, **When** it is sent, **Then** the response is 401 with a
   generic message, the password and sessions are unchanged, and no token is returned.
2. **Given** 5 attempts within a minute from the same user and address, **When** a 6th is sent,
   **Then** the response is 429 and nothing changes.
3. **Given** the limit was reached for one user, **When** a different user calls from the same
   address, **Then** that user is not blocked.

---

### User Story 4 - Validation and access (Priority: P2)

**Why this priority**: Weak or malformed passwords and unauthorized callers must never change a
password.

**Independent Test**: Send invalid bodies and policy-violating passwords; call without a token and
as a disabled user.

**Acceptance Scenarios**:

1. **Given** a new password shorter than 10 or longer than 128 characters, equal to the user's email
   (ignoring case), or equal to the current password, **When** it is sent with the correct current
   password, **Then** the response is 400 and nothing changes.
2. **Given** a missing field, a non-string value or an extra property, **When** it is sent, **Then**
   the response is 400.
3. **Given** no token or an invalid token, **When** the endpoint is called, **Then** the response
   is 401.
4. **Given** a valid token of a user since disabled or deleted, **When** the endpoint is called,
   **Then** the response is the generic 401 (as US-05) and nothing changes.

### Edge Cases

- Malformed bodies (missing fields, wrong types, extra properties) get 400 before any password check.
- Wrong current password together with a policy-violating new password: 401 (the current password is
  checked first, so the policy check reveals nothing to someone who does not know it).
- Two concurrent changes by the same user: no partial state (hash changed but sessions not revoked)
  is ever visible; the last committed change wins and only its token pair stays valid.
- If the transaction fails, the old password and sessions remain and no tokens are returned.
- An unreachable message broker has no effect; no event is published.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST offer `POST /users/me/password`, allowed to `CUSTOMER` and `ADMIN`;
  without a valid token it returns 401.
- **FR-002**: The service MUST re-read the caller; if they do not exist or are not `ACTIVE`, it MUST
  return the generic 401 used by US-05.
- **FR-003**: The body MUST contain exactly `currentPassword` and `newPassword`, both strings;
  missing, non-string or extra properties MUST return 400.
- **FR-004**: The current password MUST be verified against the stored hash as at login
  (constant-time). A mismatch MUST return 401 with one generic message and change nothing.
- **FR-005**: Attempts MUST be rate limited per user id and client address, default 5 per minute
  (configurable); excess MUST return 429 and change nothing.
- **FR-006**: The new password MUST satisfy the registration policy (10 to 128 characters, not equal
  to the email ignoring case) and MUST differ from the current password; otherwise 400 and nothing
  changes.
- **FR-007**: On success, in one transaction, the service MUST store the new argon2id hash, revoke
  every refresh token of the user and store the caller's new refresh token; it then returns 200 with
  the new access and refresh tokens in the login response shape. If any step fails, nothing is kept.
- **FR-008**: Access tokens issued before the change remain valid until they expire; the README
  documents this trade-off.
- **FR-009**: Passwords, hashes and tokens MUST NOT appear in logs or error responses. A successful
  change MUST be logged once with the user id only.
- **FR-010**: The endpoint MUST work when the message broker is unreachable; no event is published.
- **FR-011**: The constitution TODOs `CURRENT_SESSION` and `PASSWORD_CHANGE_RATE_LIMIT` MUST be
  resolved (PATCH amendment) and the README and Swagger kept consistent.
- **FR-012**: Out of scope: password reset by email, forced change at first login, password history,
  notifying the user.

### Key Entities

- **User** (existing): password hash replaced; roles, status and `customerId` unchanged.
- **Refresh token** (existing): all of the user's revoked; one new token (new family) issued to the
  caller.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a change, 100% of logins with the old password fail and 100% with the new one
  succeed.
- **SC-002**: After a change, 100% of refresh tokens issued before it are refused and the newly
  returned one is accepted.
- **SC-003**: 0 password changes succeed with a wrong current password, an invalid new password, or
  a disabled caller.
- **SC-004**: The 6th attempt within a minute for the same user and address is refused in 100% of
  tests.
- **SC-005**: 0 occurrences of passwords, hashes or tokens in logs during the test suite.
- **SC-006**: The caller keeps working without signing in again after 100% of successful changes.

## Assumptions

- The rate limit counts every attempt (successful or not), like the existing register and login
  limits.
- "Different from the current one" is checked by verifying the new password against the stored hash.
- No audit record is written: a self-service password change is not an admin mutation
  (constitution XI covers admin mutations only).
- The new token pair starts a new refresh-token family.
- Validation errors use the existing 400 format.
