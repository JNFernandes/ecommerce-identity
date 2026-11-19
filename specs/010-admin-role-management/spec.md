# Feature Specification: An administrator assigns and revokes roles (US-10)

**Feature Branch**: `feature/US-10-admin-role-management`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-10: Admin assigns and revokes roles. `PUT /users/{id}/roles` (ADMIN
only) with roles: a non-empty list of CUSTOMER and/or ADMIN, replacing the user's roles. 200 with the
user in the admin read shape. Safeguards (409): an admin cannot remove their own ADMIN role, and the
last ACTIVE admin never loses ADMIN; user row locked during the change (same approach as US-07).
Granting CUSTOMER to a user without a customerId creates one and publishes identity.user-registered
(US-01 payload and dead-letter fallback). Removing CUSTOMER keeps the customerId. Granting ADMIN
never touches the customerId. Revoking a role revokes all the user's refresh tokens; granting does
not. Existing access tokens keep their roles until they expire (README trade-off). Same roles: 200
no-op. Empty or unknown roles: 400. Unknown id: 404. CUSTOMER token: 403, no token: 401. Audit record
(actor, ROLES_CHANGED, target, before and after roles) in the same transaction (US-09 audit table).
Out of scope: audit read endpoint (US-11), custom roles, bulk changes."

## Clarifications

### Session 2026-11-19

- Q: May a user hold both roles, given constitution III ("admins have no `customerId`") and US-09
  (one role)? → A: Yes. `[CUSTOMER, ADMIN]` is allowed here; `POST /users` stays one role. Constitution
  III is amended (PATCH) so that admins created by the seed or `POST /users` have no `customerId`,
  and a kept `customerId` is dormant unless the roles include `CUSTOMER`. Settles
  TODO(ROLE_CHANGE_CUSTOMER_ID).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Promote a user to administrator (Priority: P1)

An administrator grants `ADMIN` to an existing user. At their next login or refresh the user acts as
an administrator.

**Why this priority**: The main reason for the story: admin rights change without a redeploy or a new
account (constitution III, ADR 0008).

**Independent Test**: As the seeded admin, set a customer's roles to include `ADMIN`; log in as that
user and call an admin-only endpoint.

**Acceptance Scenarios**:

1. **Given** an `ACTIVE` admin and a customer, **When** the admin sets the customer's roles to
   include `ADMIN`, **Then** the response is 200 with the user in the admin read shape showing the
   new roles, and the `customerId` is unchanged.
2. **Given** that change, **When** the user logs in again, **Then** the new token carries the new
   roles and the admin-only endpoint answers.
3. **Given** a grant only (no role removed), **When** it completes, **Then** the user's existing
   sessions keep working and no `identity.user-registered` event is published.

---

### User Story 2 - Revoke a role (Priority: P1)

An administrator removes a role from a user (for example demotes another admin). The user's sessions
end so the next token they get reflects the reduced roles.

**Why this priority**: Removing access is the security-critical half of the story.

**Independent Test**: Demote a second admin; check that their refresh token is refused and that a new
login gives a token without `ADMIN`.

**Acceptance Scenarios**:

1. **Given** two `ACTIVE` admins A and B, **When** A removes `ADMIN` from B, **Then** the response is
   200 and every refresh token of B is revoked.
2. **Given** a user with `CUSTOMER` and a `customerId`, **When** `CUSTOMER` is removed, **Then** the
   `customerId` is kept (stored and shown in the admin read shape) and no event is published.
3. **Given** B still holds an access token issued before the change, **When** B uses it, **Then** it
   keeps its old roles until it expires (documented trade-off, constitution III).

---

### User Story 3 - Grant CUSTOMER to a user without a customer identity (Priority: P2)

An administrator gives `CUSTOMER` to a user who never had a `customerId` (for example an admin who
also wants to shop). The user gets one and Orders learns about it through the usual event.

**Why this priority**: Without the event, Orders never creates the customer record and the user
cannot order.

**Independent Test**: Grant `CUSTOMER` to an admin without `customerId`; check the response, the
stored user and the single event on `identity.user-registered`.

**Acceptance Scenarios**:

1. **Given** a user without `customerId`, **When** `CUSTOMER` is granted, **Then** the user gets a
   new `customerId` different from the user id, and after the commit exactly one
   `identity.user-registered` event is published with the US-01 payload and key.
2. **Given** a user who already has a `customerId` (from an earlier `CUSTOMER` role), **When**
   `CUSTOMER` is granted again, **Then** the same `customerId` is reused and no event is published.
3. **Given** the message broker is unreachable, **When** `CUSTOMER` is granted, **Then** the
   response is still 200 and the event is stored for redelivery with the same `eventId`.

---

### User Story 4 - Safeguards keep at least one administrator (Priority: P1)

**Why this priority**: Losing every admin locks the platform out of all admin operations
(constitution III, NON-NEGOTIABLE).

**Independent Test**: Try to remove one's own `ADMIN`, remove the last `ACTIVE` admin's `ADMIN`, and
send two concurrent demotions of the last two admins.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they remove `ADMIN` from their own roles, **Then** the response is
   409 and nothing changes.
2. **Given** only one `ACTIVE` admin (other admins `DISABLED`), **When** another admin's request
   would remove `ADMIN` from them, **Then** the response is 409 and nothing changes.
3. **Given** exactly two `ACTIVE` admins, **When** each concurrently removes `ADMIN` from the other,
   **Then** at most one request succeeds and at least one `ACTIVE` admin remains.

---

### User Story 5 - Validation, access and audit (Priority: P2)

**Why this priority**: Only active admins may change roles, and every change leaves a permanent trace
(constitution XI).

**Independent Test**: Send invalid bodies, unknown ids and unauthorized callers; read the stored audit
record; make the audit write fail.

**Acceptance Scenarios**:

1. **Given** an empty roles list, an unknown role, a missing `roles` or an extra property, **When**
   it is sent, **Then** the response is 400 and nothing changes.
2. **Given** an unknown user id, **When** it is sent, **Then** the response is 404.
3. **Given** no token, a customer token, or the token of an admin since disabled or demoted, **When**
   the endpoint is called, **Then** the response is 401, 403 and the generic 401 respectively.
4. **Given** the requested roles equal the current roles, **When** it is sent, **Then** the response
   is 200 with the user, and no session is revoked, no event published and no audit record written.
5. **Given** a successful change, **When** it completes, **Then** exactly one audit record exists
   with the acting admin id, action `ROLES_CHANGED`, the target id, the roles before and after, and
   the time; if the audit write fails, the role change is not kept either.

### Edge Cases

- Repeated roles (`[ADMIN, ADMIN]`): 400, as in US-09.
- Changing roles of a `DISABLED` user is allowed; a `DISABLED` admin is not counted as an `ACTIVE`
  admin for the last-admin rule.
- An admin changing their own roles without removing `ADMIN` (e.g. adding `CUSTOMER`) is allowed.
- A concurrent status change (US-07) and role change on the last two admins cannot together leave
  zero `ACTIVE` admins.
- The startup seed is unaffected: it creates an admin only when none exists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST offer `PUT /users/{id}/roles`, allowed only to the `ADMIN` role;
  without a token it returns 401, for a `CUSTOMER` token 403.
- **FR-002**: Before changing anything, the service MUST re-read the acting admin; if they do not
  exist, are not `ACTIVE` or no longer hold `ADMIN`, it MUST return the generic 401 (as US-07, US-09).
- **FR-003**: The body MUST contain exactly `roles`: a non-empty list of distinct values from
  `CUSTOMER` and `ADMIN`. Empty, unknown, repeated or missing values, or any extra property, MUST
  return 400. The list replaces the user's roles; `[CUSTOMER, ADMIN]` (any order) is allowed.
- **FR-004**: An unknown target id MUST return 404.
- **FR-005**: The service MUST return 409 and change nothing when the acting admin would remove
  `ADMIN` from themselves, or when the change would leave no `ACTIVE` user holding `ADMIN`. The
  check MUST be race-safe: the target row is locked for the change and concurrent role and status
  changes cannot together remove the last `ACTIVE` admin (same approach as US-07).
- **FR-006**: If the new roles equal the current roles (order ignored), the service MUST return 200
  with the user and change, revoke, publish and audit nothing.
- **FR-007**: Granting `CUSTOMER` to a user without `customerId` MUST create a new `customerId`
  (different from the user id) and, after the commit, publish exactly one
  `identity.user-registered` event with the US-01 payload and key; on publish failure it MUST log,
  store the event for redelivery with the same `eventId`, and still return 200. A user who already
  has a `customerId` keeps it and no event is published.
- **FR-008**: Removing `CUSTOMER` MUST keep the `customerId`. Granting or removing `ADMIN` MUST never
  change the `customerId`.
- **FR-008a**: Access tokens MUST carry `customerId` only when the user's roles include `CUSTOMER`;
  a dormant `customerId` (roles without `CUSTOMER`) is never put in a token.
- **FR-009**: If any role is removed, all the target's refresh tokens MUST be revoked in the same
  transaction; a grant-only change MUST revoke none. Access tokens already issued keep their roles
  until they expire.
- **FR-010**: In the same transaction as the change, the service MUST write one append-only audit
  record (actor id, `ROLES_CHANGED`, target id, before roles, after roles, time) in the audit store
  from US-09; if either write fails, neither is kept. No password, hash or token in it.
- **FR-011**: The response MUST be 200 with the user in the admin read shape used by
  `GET /users/{id}`.
- **FR-012**: Each successful change MUST be logged once with the actor id, target id, before and
  after roles (no email, name or token).
- **FR-013**: The endpoint MUST work when the message broker is unreachable.
- **FR-014a**: Constitution III MUST be amended in this story (see Clarifications) and the README and
  ADR index kept consistent.
- **FR-014**: Out of scope: the audit read endpoint (US-11), custom roles, bulk changes.

### Key Entities

- **User** (existing): roles replaced; `customerId` created on first `CUSTOMER` grant, never removed.
- **Refresh token** (existing): all of the target's revoked when a role is removed.
- **Audit record** (existing, US-09): new action `ROLES_CHANGED` with before and after roles.
- **User registered event** (existing): unchanged payload; published on first `CUSTOMER` grant.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A role change takes effect at the user's next login or refresh in 100% of cases.
- **SC-002**: In concurrent tests, 0 runs end with no `ACTIVE` admin.
- **SC-003**: 100% of effective changes have exactly one audit record; 0 for no-ops or failures.
- **SC-004**: After any role removal, 100% of the target's refresh tokens are refused.
- **SC-005**: 100% of first `CUSTOMER` grants reach the `identity.user-registered` topic, including
  after a broker outage.
- **SC-006**: 0 role changes succeed for a caller without a token, with a customer token, or with
  the token of a disabled or demoted admin.

## Assumptions

- Validation errors use the existing 400 format; the target is locked the same way as in US-07.
- A no-op is detected before the safeguards, so re-sending an admin's own current roles returns 200.
- Changing roles of a `DISABLED` user is allowed and does not change their status.
- The `customerId` and the event are not reversible: removing then re-granting `CUSTOMER` reuses the
  same `customerId` and never republishes.
- The access-token trade-off (old roles until expiry, 15 min default) is already in the README.
