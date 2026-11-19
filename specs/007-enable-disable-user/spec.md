# Feature Specification: Enable or disable a user (US-07)

**Feature Branch**: `feature/US-07-enable-disable-user`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "US-07: Enable or disable a user. Endpoint: PATCH /users/{id}/status
with { "status": "ACTIVE" | "DISABLED" }, ADMIN only (guards from US-05). Response 200 with the
user in the same shape as GET /users/{id} (US-06). Disabling sets DISABLED and, in the same
transaction, revokes every refresh token of the user (all families); afterwards login and refresh
fail with the generic 401 and GET /users/me returns 401. Enabling sets ACTIVE and does not restore
revoked tokens. Access tokens already issued stay valid for token-only routes until they expire
(at most JWT_ACCESS_TTL_SECONDS); the README states this trade-off. An admin cannot disable their
own account and the last ACTIVE admin can never be disabled (409 with a clear message).
Idempotent: same status returns 200 and changes nothing. The user row is locked while the status
changes so concurrent admins cannot bypass the last-admin rule. 404 unknown id, 400 invalid status
or malformed id (never 500), 403 CUSTOMER token, 401 without a valid token. Every change is logged
with acting admin id, target id, old and new status (no emails, no tokens). Works when Kafka is
unreachable. Out of scope: deleting users, changing roles, bulk operations, a reason field,
publishing a status-changed event."

## Clarifications

### Session 2026-11-18

- Q: Statuses? → A: Only `ACTIVE` and `DISABLED`, reusing the existing `UserStatus` enum.
- Q: What does the last-admin rule count? → A: Only `ACTIVE` admins.
- Q: Are already-issued access tokens blacklisted on disable? → A: No; they expire naturally.
- Q: Publish an event on status change? → A: No event.
- Q: Log line content? → A: As specified in FR-011 (actor id, target id, old and new status).
- Q: Can a disabled admin holding a still-valid access token use `PATCH /users/{id}/status`? → A:
  No. The endpoint re-reads the acting admin, and if they are not `ACTIVE` (or no longer exist) it
  returns the generic 401 and changes nothing. Other token-only routes are unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin disables a user and cuts off their sessions (Priority: P1)

An admin blocks an account. From that moment the user can no longer log in, refresh a session or
read their own profile, and every session they had is revoked.

**Why this priority**: The core of the story; blocking a compromised or abusive account is the
reason the feature exists.

**Independent Test**: Register and log in a customer (keep its refresh token), disable it as an
admin, then try login, refresh with the kept token and `GET /users/me` with the customer's access
token.

**Acceptance Scenarios**:

1. **Given** an admin token and an `ACTIVE` user, **When** `PATCH /users/{id}/status` is called
   with `DISABLED`, **Then** the response is 200 with the user in the `GET /users/{id}` shape and
   `status: DISABLED`.
2. **Given** the user had refresh tokens in one or more sessions, **When** they are disabled,
   **Then** every one of those refresh tokens is revoked together with the status change: either
   both happen or neither does.
3. **Given** a disabled user, **When** they log in with correct credentials, **Then** the response
   is the same generic 401 as for any other login failure.
4. **Given** a disabled user, **When** any of their previous refresh tokens is used, **Then** the
   response is the same generic 401 as for any other refresh failure.
5. **Given** a disabled user with a still-unexpired access token, **When** `GET /users/me` is
   called, **Then** the response is 401.
6. **Given** a disabled user with a still-unexpired access token, **When** a route that only checks
   the token is called, **Then** it is still accepted until the token expires (documented
   trade-off).

---

### User Story 2 - Admin re-enables a user (Priority: P1)

An admin restores a blocked account. The user can log in again but must start a new session.

**Why this priority**: Disabling without a way back would turn every mistake into data loss.

**Independent Test**: Disable a user, enable it, try a previous refresh token (fails), then log in
(succeeds).

**Acceptance Scenarios**:

1. **Given** an admin token and a `DISABLED` user, **When** `PATCH /users/{id}/status` is called
   with `ACTIVE`, **Then** the response is 200 with `status: ACTIVE`.
2. **Given** the re-enabled user, **When** they log in with correct credentials, **Then** login
   succeeds.
3. **Given** the re-enabled user, **When** a refresh token revoked by the earlier disable is used,
   **Then** the response is the generic 401 (revoked tokens are never restored).

---

### User Story 3 - Safeguards keep at least one admin able to act (Priority: P1)

The system refuses status changes that would lock administrators out.

**Why this priority**: Admins exist only through the startup seed, which never runs again while an
admin exists; losing every active admin would be unrecoverable through the API.

**Independent Test**: As the only active admin, try to disable yourself; with two admins, have
each try to disable the other at the same time.

**Acceptance Scenarios**:

1. **Given** an admin token, **When** the admin calls the endpoint with `DISABLED` on their own id,
   **Then** the response is 409 with a message saying an admin cannot disable their own account,
   and nothing changes.
2. **Given** a target admin who is the only `ACTIVE` admin, **When** any request would disable
   them, **Then** the response is 409 with a message saying the last active admin cannot be
   disabled, and nothing changes.
3. **Given** exactly two `ACTIVE` admins, **When** each sends a request to disable the other at the
   same time, **Then** at most one request succeeds, the other is refused (401, because its acting
   admin is now disabled, per FR-016), and exactly one `ACTIVE` admin remains.
4. **Given** an admin enabling their own account or setting their own status to `ACTIVE`, **When**
   the endpoint is called, **Then** it is allowed (200, no change).
5. **Given** an admin who was disabled but still holds an unexpired access token, **When** they call
   the endpoint with any target and status (including re-enabling themselves), **Then** the
   response is the generic 401 and nothing changes.

---

### User Story 4 - Repeated requests are harmless (Priority: P2)

Setting the status a user already has succeeds and changes nothing.

**Why this priority**: Retries from clients or double clicks must not fail or cause side effects.

**Independent Test**: Disable a user twice and enable an active user; compare data, tokens and
logs before and after.

**Acceptance Scenarios**:

1. **Given** a `DISABLED` user, **When** `DISABLED` is requested again, **Then** the response is
   200 with the user unchanged and no status-change log entry.
2. **Given** an `ACTIVE` user, **When** `ACTIVE` is requested, **Then** the response is 200 with the
   user unchanged and their refresh tokens untouched.

---

### User Story 5 - Only admins can change status, with clear errors (Priority: P1)

The endpoint is protected by the US-05 guards and validates its input.

**Why this priority**: Status control over any account is a high-privilege action.

**Independent Test**: Call the endpoint with no token, an invalid token, a customer token, an
unknown id, a malformed id and invalid bodies.

**Acceptance Scenarios**:

1. **Given** no token or an invalid token, **When** the endpoint is called, **Then** the response
   is the generic 401 from US-05.
2. **Given** a valid customer token, **When** the endpoint is called, **Then** the response is 403
   and nothing changes.
3. **Given** an admin token and a well-formed id that matches no user, **When** the endpoint is
   called, **Then** the response is 404.
4. **Given** an admin token and a malformed id, a missing or unknown `status`, a non-string
   `status`, a malformed body or unknown body fields, **When** the endpoint is called, **Then** the
   response is 400 with validation details, never 500.

---

### User Story 6 - Every change leaves a trace (Priority: P2)

Each effective status change is logged for later investigation.

**Why this priority**: Needed to answer "who blocked this account and when", but does not block the
feature.

**Independent Test**: Disable and enable a user and inspect the logs.

**Acceptance Scenarios**:

1. **Given** an effective change, **When** the logs are inspected, **Then** one entry contains the
   acting admin id, the target user id, the old status and the new status.
2. **Given** any request to the endpoint, **When** the logs are inspected, **Then** no email,
   password, token or `Authorization` header appears.

### Edge Cases

- Disabling a user with no refresh tokens: succeeds; nothing to revoke.
- Disabling a user whose token families are already partly revoked or expired: all remaining ones
  are revoked; already-revoked ones stay revoked.
- A refresh in flight while the user is disabled: either it completes before the disable (and the
  new token is then revoked by it) or it fails with 401; no refresh token of a disabled user stays
  usable.
- A disabled admin: counts as not active for the last-admin rule; can be re-enabled by another
  admin.
- Disabling an admin when another admin exists but is `DISABLED`: refused as the last active admin.
- An admin whose own account was disabled by another admin while holding a valid access token: can
  still reach token-only routes until the token expires, but cannot log in, refresh or call
  `PATCH /users/{id}/status` (generic 401).
- Status value in a different case (`disabled`): 400 (values are exact).
- Messaging unavailable: the endpoint works normally; it publishes nothing.
- Database unavailable: 5xx, nothing changed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `PATCH /users/{id}/status`, restricted to `ADMIN`, accepting a
  body with exactly one field `status` whose value is `ACTIVE` or `DISABLED`.
- **FR-002**: On success the response MUST be 200 with the target user in the same shape as
  `GET /users/{id}` (US-06), reflecting the status after the request.
- **FR-003**: Setting `DISABLED` on an `ACTIVE` user MUST change the status and revoke every
  refresh token of that user (all families) as one atomic change.
- **FR-004**: Setting `ACTIVE` on a `DISABLED` user MUST change the status and MUST NOT restore any
  revoked refresh token.
- **FR-005**: Requesting the status the user already has MUST return 200 and change nothing (no
  data, token or log change).
- **FR-006**: Login and refresh MUST refuse a disabled user with the same generic 401 used for every
  other credential or refresh failure; `GET /users/me` MUST return 401 for a disabled user.
- **FR-007**: An admin MUST NOT be able to disable their own account: 409 with a clear message.
- **FR-008**: The system MUST refuse to disable the last `ACTIVE` admin: 409 with a clear message.
- **FR-009**: Concurrent status changes MUST be serialized so that the last-admin rule holds under
  concurrency: at least one `ACTIVE` admin always remains.
- **FR-010**: Unknown id MUST return 404; malformed id or invalid body MUST return 400 with
  validation details; no or invalid token MUST return the generic 401; a token without `ADMIN` MUST
  return 403. No input MUST produce a 500.
- **FR-011**: Every effective status change MUST be logged with the acting admin id, target user id,
  old status and new status, and MUST NOT log emails, passwords or tokens.
- **FR-012**: The endpoint MUST work when the messaging system is unreachable and MUST NOT publish
  any event.
- **FR-013**: Access tokens already issued are not revoked; they remain valid on routes that only
  verify the token until they expire. The README MUST state this trade-off and its upper bound
  (`JWT_ACCESS_TTL_SECONDS`).
- **FR-014**: The API documentation MUST describe the endpoint, its body, response shape, required
  role and 400/401/403/404/409 responses.
- **FR-015**: The endpoint MUST NOT change any other user field (role, email, name, password).
- **FR-016**: The endpoint MUST re-read the acting admin (token `sub`) from storage before any
  change; if that user does not exist or is not `ACTIVE`, it MUST return the generic 401 and change
  nothing. This check applies only to this endpoint; other token-only routes keep the FR-013
  trade-off.

### Key Entities

- **User** (existing): `status` (`ACTIVE` / `DISABLED`) is the field changed; roles decide the
  admin safeguards.
- **Refresh token** (existing): every token of the user is revoked when the user is disabled; never
  un-revoked.
- **Status change log entry**: acting admin id, target user id, old status, new status, time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a disable, 100% of login and refresh attempts for that user fail with the
  generic 401, immediately (no delay or cache).
- **SC-002**: After a disable, 0 refresh tokens of that user remain usable.
- **SC-003**: Under any interleaving of concurrent disable requests, the number of `ACTIVE` admins
  never drops to 0.
- **SC-004**: 100% of customer-token requests get 403 and 100% of unauthenticated requests get 401.
- **SC-005**: 0 server errors (5xx) for any malformed id or body in the test suite.
- **SC-006**: 100% of effective status changes produce one log entry with actor, target, old and
  new status; 0 log lines contain an email or token.
- **SC-007**: A disabled user regains access within one login after being re-enabled.
- **SC-008**: 100% of status-change requests from a disabled admin's still-valid token get 401 and
  change nothing.

## Assumptions

- `ACTIVE` and `DISABLED` are the only statuses (existing `UserStatus`).
- The self-disable rule applies only to `DISABLED`; an admin setting their own status to `ACTIVE`
  is a no-op 200.
- The last-admin rule counts only `ACTIVE` users holding `ADMIN`; it is checked only when the target
  is an `ACTIVE` admin being disabled.
- When both safeguards apply (the last active admin disabling themself), the self-disable message is
  returned.
- Idempotent no-op requests are not logged as status changes (they may appear in normal request
  logs).
- The acting admin is identified by the `sub` of their access token.
- Login, refresh and `GET /users/me` already check the stored status (US-02, US-04, US-05); this
  story verifies that behaviour end to end rather than redefining it.
- Out of scope: deleting users, changing roles, bulk operations, a reason field, publishing a
  status-changed event (deferred to the security audit work).
