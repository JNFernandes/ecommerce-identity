# Feature Specification: Seed the first administrator and let admins list users (US-06)

**Feature Branch**: `feature/US-06-admin-seed-list-users`

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "US-06: Seed the first administrator and let admins list users.
Admin seed (startup): if no ADMIN exists and ADMIN_EMAIL and ADMIN_PASSWORD are set, create one
ADMIN (ACTIVE, no customerId, name from ADMIN_NAME default "Administrator", argon2id, same password
policy as registration: 10 to 128 characters, different from the email). Idempotent: an existing
admin is never overwritten; missing variables with no admin log a warning and start normally;
ADMIN_EMAIL belonging to a non-admin logs an error and skips without changing the role. The
password never appears in logs. No identity.user-registered event for admins. README documents the
variables and recommends removing ADMIN_PASSWORD after the first start. Endpoints (ADMIN only, US-05
guards): GET /users paginated, newest first (createdAt desc, id tie-break), limit default 20 max
100, offset default 0, optional filters role, status, email (case-insensitive prefix); response
items, total, limit, offset; item fields id, customerId (if any), email, name, roles, status,
createdAt, lastLoginAt, never a password or hash. GET /users/{id}: same shape, 404 when missing.
CUSTOMER token 403, no token 401, invalid filters or pagination out of range 400 with validation
details. Out of scope: creating admins through the API, changing roles or status (US-07 and IAM
stories), deleting users, searching by name."

## Clarifications

### Session 2026-11-18

- Q: May the seed promote or modify an existing user? → A: Never; it only ever creates a new admin.
- Q: What happens when the seed variables are missing and no admin exists? → A: Log a warning, start normally.
- Q: Is an event published when the admin is seeded? → A: No event of any kind.
- Q: How do the `role`, `status` and `email` filters combine? → A: AND.
- Q: Is `lastLoginAt` shown to admins? → A: Yes, in every `GET /users` item and in `GET /users/{id}`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First administrator exists after the first start (Priority: P1)

An operator deploys the service with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set. On startup the
service creates exactly one administrator, who can then log in. Later starts change nothing.

**Why this priority**: Without an admin, no admin endpoint can ever be used; the constitution
allows admins only through this seed.

**Independent Test**: Start the service on an empty database with the variables set, log in with
those credentials and check the token holds `ADMIN` and no `customerId`; restart with a different
password and check the original password still works.

**Acceptance Scenarios**:

1. **Given** no admin exists and `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set and valid, **When** the
   service starts, **Then** one user is created with role `ADMIN`, status `ACTIVE`, no
   `customerId`, name from `ADMIN_NAME` (or "Administrator" when unset) and the given credentials.
2. **Given** the seeded admin, **When** they log in, **Then** login succeeds and the access token
   carries `roles: [ADMIN]` and no `customerId`.
3. **Given** an admin already exists, **When** the service starts again (with the same or different
   variables), **Then** no user is created or changed; the existing admin's password, name and
   email stay as they were.
4. **Given** the seed creates an admin, **When** the messaging system is inspected, **Then** no
   `identity.user-registered` event was published for it.
5. **Given** any seed outcome, **When** the logs are inspected, **Then** the password value never
   appears in any log line.

---

### User Story 2 - Unsafe or incomplete seed configuration never breaks startup or data (Priority: P1)

When the seed cannot or must not run, the service says why in the logs and starts normally,
without touching existing users.

**Why this priority**: A misconfigured variable must never promote a customer to admin or block
the service from starting.

**Independent Test**: Start the service with the variables missing, with an invalid password, and
with `ADMIN_EMAIL` equal to an existing customer's email; check the logs, that the service is
healthy, and that no user was created or changed.

**Acceptance Scenarios**:

1. **Given** no admin exists and `ADMIN_EMAIL` or `ADMIN_PASSWORD` is missing or empty, **When** the
   service starts, **Then** a warning saying no admin exists and the seed variables are not set is
   logged and the service starts normally.
2. **Given** `ADMIN_EMAIL` belongs to an existing non-admin user, **When** the service starts,
   **Then** an error is logged, that user's role, password and data are unchanged, no admin is
   created, and the service starts normally.
3. **Given** `ADMIN_PASSWORD` breaks the registration policy (fewer than 10 or more than 128
   characters, or equal to the email) or `ADMIN_EMAIL`/`ADMIN_NAME` is invalid, **When** the
   service starts, **Then** an error naming the failed rule (never the value of the password) is
   logged, no admin is created, and the service starts normally.
4. **Given** an admin already exists and the variables are missing, **When** the service starts,
   **Then** nothing is logged as a warning or error about the seed.

---

### User Story 3 - Admin lists and filters users (Priority: P1)

An admin pages through all users, newest first, optionally narrowing by role, status or the start
of an email address.

**Why this priority**: The core back-office need of the story and the base for status changes in
US-07.

**Independent Test**: Seed an admin, register several customers, log in as the admin and call
`GET /users` with different pages and filters; compare with the stored users.

**Acceptance Scenarios**:

1. **Given** an admin token, **When** `GET /users` is called without parameters, **Then** the
   response is 200 with `items` (at most 20 users, newest first), `total` (all matching users),
   `limit: 20` and `offset: 0`.
2. **Given** several users with the same creation time, **When** they are listed across pages,
   **Then** the order is stable (ties broken by id) and no user appears twice or is skipped.
3. **Given** `limit` and `offset`, **When** `GET /users` is called, **Then** exactly the
   requested slice is returned and `total` is unaffected by pagination.
4. **Given** filters `role`, `status` and/or `email`, **When** `GET /users` is called, **Then** only
   users matching all given filters are returned and `total` counts only them; `email` matches
   addresses that start with the given text, ignoring case.
5. **Given** any item, **When** it is inspected, **Then** it has exactly `id`, `customerId` (omitted
   for users without one), `email`, `name`, `roles`, `status`, `createdAt` and `lastLoginAt`
   (`null` when the user never logged in), and never a password or hash.
6. **Given** an offset beyond the last matching user, **When** `GET /users` is called, **Then**
   the response is 200 with empty `items` and the real `total`.

---

### User Story 4 - Admin views one user (Priority: P2)

An admin opens a single user by id.

**Why this priority**: Useful for support, but the list already exposes the same data.

**Independent Test**: Call `GET /users/{id}` with an admin token for an existing id, an unknown id
and a malformed id.

**Acceptance Scenarios**:

1. **Given** an admin token and an existing user id, **When** `GET /users/{id}` is called, **Then**
   the response is 200 with the same fields as a list item.
2. **Given** an admin token and a well-formed id that matches no user, **When** `GET /users/{id}`
   is called, **Then** the response is 404.
3. **Given** an admin token and an id that is not a valid identifier, **When** `GET /users/{id}` is
   called, **Then** the response is 400 with validation details.

---

### User Story 5 - Only admins reach the user endpoints (Priority: P1)

The list and detail endpoints are restricted to `ADMIN` through the guards from US-05.

**Why this priority**: The endpoints expose every account; a leak is a security incident.

**Independent Test**: Call both endpoints with no token, an invalid token, a customer token and an
admin token.

**Acceptance Scenarios**:

1. **Given** no token or an invalid token, **When** either endpoint is called, **Then** the
   response is the generic 401 from US-05.
2. **Given** a valid customer token, **When** either endpoint is called, **Then** the response is
   403 and no user data is returned.
3. **Given** a valid admin token, **When** `GET /users/me` is called, **Then** it still returns the
   caller's own account (not treated as an id).
4. **Given** invalid parameters (`limit` below 1 or above 100, negative `offset`, non-integer
   values, unknown `role` or `status`, unknown query parameters), **When** `GET /users` is called by
   an admin, **Then** the response is 400 with validation details.

### Edge Cases

- `ADMIN_EMAIL` in a different case or with surrounding spaces than an existing user: normalized
  like registration, so it matches that user (non-admin → error and skip; admin → nothing).
- `ADMIN_NAME` set but blank: rejected by the same name rule as registration (error, no admin).
- An admin exists but is not `ACTIVE`: it still counts as existing; no new admin is created.
- Several instances start at the same time on an empty database: at most one admin with that email
  is created; the other instances log and start normally.
- Database unavailable at startup: the seed fails like any other startup database error; it is not
  silently skipped.
- Messaging unavailable at startup: the seed works (it publishes nothing).
- Email filter with characters that have special meaning in pattern matching (`%`, `_`): treated
  literally.
- Email filter longer than an email can be (over 254 characters) or empty: 400 / ignored
  respectively.
- `GET /users` on a database with only the admin: one item, `total: 1`.
- Database unavailable during a list or detail request: 5xx, not an empty list or 404.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: At startup, when no user with role `ADMIN` exists and both `ADMIN_EMAIL` and
  `ADMIN_PASSWORD` are set and non-empty, the system MUST create one user with role `ADMIN`, status
  `ACTIVE`, no `customerId`, name from `ADMIN_NAME` (default "Administrator") and the given email
  and password.
- **FR-002**: The seed MUST apply the registration rules: email validation and normalization, name
  rules, and the password policy (10 to 128 characters, different from the email); the password is
  stored only as an argon2id hash.
- **FR-003**: When any `ADMIN` user exists (whatever its status), the seed MUST NOT create or
  modify any user.
- **FR-004**: When no admin exists and a seed variable is missing, the system MUST log a warning
  and start normally.
- **FR-005**: The seed MUST NOT promote or modify any existing user, in any case. When
  `ADMIN_EMAIL` belongs to an existing non-admin user, the system MUST log an error, leave that
  user unchanged (role included) and start normally.
- **FR-006**: When seed values break a validation rule, the system MUST log an error naming the
  rule, create nothing and start normally.
- **FR-007**: The value of `ADMIN_PASSWORD` MUST NOT appear in any log line, error message or
  response.
- **FR-008**: The seed MUST NOT publish `identity.user-registered` or any other event.
- **FR-009**: Concurrent starts MUST NOT create more than one admin for the same email.
- **FR-010**: The system MUST expose `GET /users`, restricted to `ADMIN`, returning `items`,
  `total`, `limit` and `offset`.
- **FR-011**: `GET /users` MUST order users by creation time descending, then id, and accept
  `limit` (integer 1–100, default 20) and `offset` (integer ≥ 0, default 0).
- **FR-012**: `GET /users` MUST accept optional filters `role` (`CUSTOMER`/`ADMIN`), `status`
  (a known user status) and `email` (case-insensitive prefix, matched literally, at most 254
  characters), combined with AND; `total` counts all users matching the filters.
- **FR-013**: The system MUST expose `GET /users/{id}`, restricted to `ADMIN`, returning one user
  in the item shape, 404 when no user has that id and 400 when the id is malformed.
- **FR-014**: Each item MUST contain exactly `id`, `customerId` (omitted when absent), `email`,
  `name`, `roles`, `status`, `createdAt` and `lastLoginAt` (null when never logged in), and never a
  password or password hash.
- **FR-015**: Invalid query values, out-of-range pagination and unknown query parameters MUST
  return 400 with validation details; no token or an invalid token MUST return the generic 401; a
  token without `ADMIN` MUST return 403.
- **FR-016**: `GET /users/me` MUST keep its US-05 behaviour and not be captured by
  `GET /users/{id}`.
- **FR-017**: The test-only `ADMIN` route from US-05 MAY be replaced by these endpoints in tests.
- **FR-018**: The README and `.env.example` MUST document `ADMIN_EMAIL`, `ADMIN_PASSWORD` and
  `ADMIN_NAME`, and the README MUST recommend removing `ADMIN_PASSWORD` from the environment after
  the first start.
- **FR-019**: The API documentation MUST describe both endpoints, their parameters, response shape,
  required role and 400/401/403/404 responses.
- **FR-020**: No endpoint in this story creates users, changes roles or status, or deletes users.

### Key Entities

- **User** (existing): id, customerId (customers only), normalized email, name, roles, status,
  password hash (never exposed), creation time, last login time.
- **Admin seed configuration**: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`; read once at startup,
  never logged.
- **User page**: a slice of users matching the filters, with the total count and the applied
  `limit` and `offset`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a fresh deployment with the seed variables set, the operator can log in as
  admin on the first attempt, with no manual database step.
- **SC-002**: Across any number of restarts, exactly one seeded admin exists and its password is
  never changed by the seed.
- **SC-003**: 0 seed runs change the role or data of an existing non-admin user.
- **SC-004**: 0 occurrences of the admin password in any log line across the test suite.
- **SC-005**: 0 `identity.user-registered` events published for admins.
- **SC-006**: An admin can find a user by the start of their email in a single request answered in
  under 1 second with 10,000 stored users.
- **SC-007**: 100% of customer-token requests to the user endpoints get 403 and 100% of
  unauthenticated requests get 401.
- **SC-008**: Paging through all users with any page size returns every matching user exactly once.

## Assumptions

- "Admin exists" means any user holding `ADMIN`, whatever its status; the seed never re-enables or
  repairs an existing admin.
- Seed failures caused by configuration (missing or invalid values, email taken by a non-admin) do
  not stop startup; database failures do.
- `ADMIN_NAME` follows the registration name rules; email normalization is the same as
  registration (trim, lower-case).
- The seed runs after migrations, before the service accepts requests.
- A malformed id in `GET /users/{id}` is 400, not 404, consistent with other validation errors.
- An empty `email` filter is treated as absent.
- `lastLoginAt` is shown to admins through these endpoints only; `GET /users/me` keeps its US-05
  shape (no `lastLoginAt`).
- Out of scope: creating admins through the API, changing roles or status (US-07 and IAM stories),
  deleting users, searching by name.
