# Feature Specification: An administrator creates a user with a role (US-09)

**Feature Branch**: `feature/US-09-admin-create-user`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-09: An administrator creates a user with a role. `POST /users`, ADMIN
only, with email, name, password and roles (a non-empty list of CUSTOMER and/or ADMIN). 201 with the
user in the admin read shape. Same validation, normalization and uniqueness as registration (409 on
duplicate email). A user with CUSTOMER gets a new customerId and `identity.user-registered` is
published after the commit with the US-01 payload and dead-letter fallback; ADMIN only: no
customerId, no event. argon2id; the admin chooses the initial password (README recommends changing
it); never in a response or log. Status ACTIVE; unknown properties 400; the body can never set ids,
status or customerId. Audit record (actor, USER_CREATED, target, roles) in the same transaction
(minimal append-only table or log until US-11, decided in the plan). 400 / 401 / 403 / 409. Works
with Kafka down. Out of scope: role changes (US-10), audit read endpoint (US-11), temporary passwords
or forced password change."

## Clarifications

### Session 2026-11-19

- Q: Can one user hold both roles (`[CUSTOMER, ADMIN]`)? → A: No. `roles` must be exactly `[CUSTOMER]`
  or `[ADMIN]`; both together return 400 (keeps "admins have no `customerId`", constitution III).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create another administrator (Priority: P1)

An administrator creates a second administrator account with an email, a name, an initial password
and the role `ADMIN`. The new admin can log in at once with that password.

**Why this priority**: Today the only admin comes from the startup seed; adding or replacing an admin
needs a redeploy. This is the main reason for the story (constitution 1.1.0, ADR 0008).

**Independent Test**: As the seeded admin, create an `ADMIN` user, then log in as that user and call
an admin-only endpoint.

**Acceptance Scenarios**:

1. **Given** an `ACTIVE` admin, **When** they create a user with roles `[ADMIN]`, **Then** the
   response is 201 with the user in the admin read shape: roles `[ADMIN]`, status `ACTIVE`, no
   `customerId`, `lastLoginAt` null, no password or hash.
2. **Given** that new admin, **When** they log in with the chosen password, **Then** login succeeds
   and their token carries role `ADMIN` and no `customerId`.
3. **Given** a user created with only `ADMIN`, **When** the creation completes, **Then** no
   `identity.user-registered` event is published.

---

### User Story 2 - Create a customer on someone's behalf (Priority: P1)

An administrator creates a customer account (for example for a phone order). The customer gets a
`customerId` exactly as if they had registered, and Orders learns about them through the usual
`identity.user-registered` event.

**Why this priority**: A customer created by an admin must be usable in the rest of the platform;
without the event, Orders never creates the customer record.

**Independent Test**: Create a `[CUSTOMER]` user, check the response, the stored user and the single
event on `identity.user-registered`.

**Acceptance Scenarios**:

1. **Given** an `ACTIVE` admin, **When** they create a user with roles `[CUSTOMER]`, **Then** the
   response is 201 with a new `customerId` different from the user id, roles `[CUSTOMER]` and
   status `ACTIVE`.
2. **Given** that creation, **When** the user is committed, **Then** exactly one
   `identity.user-registered` event is published afterwards, with the same fields as a registration
   (`eventId`, `aggregateId` = user id, `occurredAt`, `version`, `customerId`, `email`, `name`),
   keyed by the user id.
3. **Given** the message broker is unreachable, **When** the admin creates a customer, **Then** the
   response is still 201, the user is stored, and the event is stored for redelivery with the same
   `eventId` (as for registration).

---

### User Story 3 - Invalid or conflicting input is rejected (Priority: P2)

The request follows exactly the registration rules for email, name and password, and accepts nothing
else besides the roles.

**Why this priority**: Prevents malformed accounts and any attempt to set fields the server owns.

**Independent Test**: Send each invalid body and an existing email; check the status and that no
user, audit record or event was created.

**Acceptance Scenarios**:

1. **Given** an email that is already used (in any letter case or with surrounding spaces), **When**
   the admin creates a user with it, **Then** the response is 409 and nothing is created.
2. **Given** an invalid email, a name outside the registration rule, a password outside the
   registration policy (or equal to the email), a missing field, an empty roles list, an unknown
   role, a repeated role, or both roles together, **When** the admin submits it, **Then** the
   response is 400 and nothing is created.
3. **Given** a body with any extra property (for example `id`, `customerId`, `status`,
   `createdAt`), **When** it is submitted, **Then** the response is 400 and nothing is created.
4. **Given** a valid body with `"  Ana@Example.COM "` and `"  Ana  "`, **When** it is created,
   **Then** the stored email is `ana@example.com` and the name `Ana`.

---

### User Story 4 - Only active administrators can create users (Priority: P2)

**Why this priority**: Creating admins is the most sensitive operation of the service; a customer, an
anonymous caller or a disabled admin must never reach it.

**Independent Test**: Call the endpoint without a token, with a customer token and with the token of
an admin who has since been disabled.

**Acceptance Scenarios**:

1. **Given** no access token, **When** the endpoint is called, **Then** the response is 401.
2. **Given** a customer's access token, **When** the endpoint is called, **Then** the response is
   403 and nothing is created.
3. **Given** an admin who was disabled after their access token was issued, **When** they call the
   endpoint with that token, **Then** the response is the generic 401 and nothing is created.

---

### User Story 5 - Every creation is audited, never with secrets (Priority: P2)

**Why this priority**: Constitution principle XI requires a permanent trace of who created which
account with which roles.

**Independent Test**: Create a user, read the stored audit record directly, and make the audit write
fail to check that the user is not created either.

**Acceptance Scenarios**:

1. **Given** a successful creation, **When** it completes, **Then** exactly one audit record exists
   with the acting admin id, action `USER_CREATED`, the new user id, the created roles and the time.
2. **Given** the audit record cannot be written, **When** the admin creates a user, **Then** the
   request fails and neither the user nor the record nor the event exists.
3. **Given** any creation, success or failure, **When** logs and the audit record are inspected,
   **Then** they contain no password, password hash or token, and the response contains no password
   or hash.

### Edge Cases

- Two concurrent requests with the same new email: exactly one succeeds (201), the other gets 409.
- Roles given as `[ADMIN, CUSTOMER]` or `[CUSTOMER, ADMIN]`: 400 (one role per user, FR-006).
- The email belongs to a `DISABLED` user: still 409 (emails are unique whatever the status).
- An admin creating an `ADMIN` user does not change the startup seed: the seed already sees an admin.
- The startup seed creating the first admin is not an admin action and writes no audit record.
- The broker is down: creation of a customer succeeds and the event is retried later by the outbound
  retry worker (US-08).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST offer `POST /users`, allowed only to the `ADMIN` role; without a token
  it returns 401 and for a `CUSTOMER` token 403.
- **FR-002**: Before creating anything, the service MUST re-read the acting admin (token subject);
  if that user does not exist, is not `ACTIVE`, or no longer holds `ADMIN`, it MUST return the
  generic 401 and create nothing (same rule as `PATCH /users/{id}/status`).
- **FR-003**: The body MUST contain exactly `email`, `name`, `password` and `roles`; any other
  property MUST be rejected with 400, so the body can never set ids, status, `customerId` or times.
- **FR-004**: Email, name and password MUST follow exactly the registration rules (US-01):
  validation, normalization (email trimmed and lowercased; name trimmed) and the password policy
  (10–128 characters, not equal to the email).
- **FR-005**: An email already used by any user (whatever its status) MUST return 409; with
  concurrent requests for the same email, at most one user is created.
- **FR-006**: `roles` MUST be exactly `[CUSTOMER]` or `[ADMIN]`. An empty list, an unknown value, a
  repeated value or both roles together (`[CUSTOMER, ADMIN]` in any order) return 400 and create
  nothing (one role per user, constitution III: admins have no `customerId`).
- **FR-007**: The created user MUST be `ACTIVE`, with new server-generated ids and timestamps and
  `lastLoginAt` empty. A user whose roles include `CUSTOMER` MUST get a new `customerId`, different
  from the user id; a user with only `ADMIN` MUST have none.
- **FR-008**: The password MUST be stored only as an argon2id hash and MUST never appear in a
  response, a log line or an audit record.
- **FR-009**: The response MUST be 201 with the user in the admin read shape used by
  `GET /users/{id}` (id, `customerId` only when present, email, name, roles, status, `createdAt`,
  `lastLoginAt`).
- **FR-010**: In the same transaction as the user, the service MUST write one append-only audit
  record: acting admin id, action `USER_CREATED`, new user id, the created roles (the "after"
  state), and the time. If either write fails, neither is kept. Records are never updated or
  deleted and never contain a password, hash or token. A log line alone does not satisfy this
  (it is not transactional nor append-only storage, constitution XI); the record's storage is
  chosen in the plan and must be the one US-11 reads (or migrated by US-11).
- **FR-011**: For a user whose roles include `CUSTOMER`, after the commit the service MUST publish
  exactly one `identity.user-registered` event with the registration payload and key; if publishing
  fails, it MUST log the failure and store the event for redelivery with the same `eventId`, and
  still return 201. For a user with only `ADMIN`, no event is published.
- **FR-012**: Each successful creation MUST be logged once with the acting admin id, the new user id
  and the roles (no email, name, password or token).
- **FR-013**: The endpoint MUST work and return 201 when the message broker is unreachable.
- **FR-014**: Out of scope: changing roles of existing users (US-10), reading the audit trail
  (US-11), temporary passwords, forced password change and any email to the new user.

### Key Entities

- **User** (existing): created with email, name, password hash, roles, status `ACTIVE`, optional
  `customerId`.
- **Audit record** (new): actor id, action (`USER_CREATED`), target id, before (none for a
  creation), after (the created roles), time. Append-only.
- **User registered event** (existing): unchanged payload, published only for users with `CUSTOMER`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin creates a working account (customer or admin) in one request; the new user
  can log in immediately in 100% of successful creations.
- **SC-002**: 100% of successful creations have exactly one matching audit record; 0 audit records
  exist for failed creations.
- **SC-003**: 0 responses, log lines or audit records contain a password, password hash or token
  (checked by tests on captured output).
- **SC-004**: 100% of customers created by an admin reach the `identity.user-registered` topic
  exactly as registered customers do, including after a broker outage.
- **SC-005**: 0 users can be created by a caller without a token, with a customer token, or with the
  token of a disabled admin.
- **SC-006**: With the broker down for the whole test, creation succeeds in 100% of valid requests.

## Assumptions

- The registration rules and messages (US-01) are reused unchanged; validation errors use the same
  400 format.
- Repeated roles (`[ADMIN, ADMIN]`) are rejected rather than silently de-duplicated, so the stored
  roles always equal what the admin sent.
- The endpoint is not rate limited (admin only, not public); the password-change rate limit belongs
  to its own story.
- The acting admin re-check (FR-002) mirrors US-07: a disabled admin's still-valid token cannot
  create users.
- The README already recommends that admin-created users change their password (constitution 1.1.0);
  this story keeps that note accurate once the endpoint exists.
- The audit storage chosen here is the one US-11 will read; if US-11 changes its shape, it migrates
  these records.
