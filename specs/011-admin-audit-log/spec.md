# Feature Specification: Audit log of administrative actions (US-11)

**Feature Branch**: `feature/US-11-admin-audit-log`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description: "US-11: Audit log of administrative actions. GET /audit (ADMIN only)
lists the audit records written by the administrative mutations (USER_CREATED from US-09,
ROLES_CHANGED from US-10, and the status changes of US-07). The table already exists from US-09.
US-07 status changes are retrofitted: USER_STATUS_CHANGED (actor, target, before and after status)
in the same transaction; a no-op writes nothing. Records are append-only; a database trigger or
permission rule blocks UPDATE and DELETE (documented in the README). Response fields: id, actorId,
action, targetId, before, after, createdAt; never passwords, hashes, tokens or other users' emails.
Newest first (createdAt desc, id tie-break), limit default 20 max 100, offset default 0. Combinable
filters actorId, targetId, action (enum). Response: items, total, limit, offset. 400 for invalid
filters or pagination, 403 for a CUSTOMER token, 401 without a token, never a 500 for bad input.
Filter indexes created by a migration. Out of scope: export, deletion or archiving, auditing login
attempts, a UI."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the audit trail (Priority: P1)

An administrator lists what administrators have changed, newest first, page by page.

**Why this priority**: The trail is written since US-09 but nobody can read it (constitution XI).

**Independent Test**: As the seeded admin, create a user and change their roles; call `GET /audit`
and check both records, their order and the page metadata.

**Acceptance Scenarios**:

1. **Given** audit records exist, **When** an `ACTIVE` admin calls `GET /audit` without parameters,
   **Then** the response is 200 with `items` (at most 20, newest first), `total` (all matching
   records), `limit` 20 and `offset` 0.
2. **Given** each item, **Then** it holds exactly `id`, `actorId`, `action`, `targetId`, `before`,
   `after` and `createdAt`, and none contains a password, hash, token or email.
3. **Given** two records with the same time, **Then** their order is stable (id as tie-break) and
   paging through all pages returns every record exactly once.
4. **Given** `limit` and `offset`, **When** `offset` is past the last record, **Then** the response
   is 200 with empty `items` and the real `total`.
5. **Given** no records match, **Then** the response is 200 with empty `items` and `total` 0.

---

### User Story 2 - Filter the trail (Priority: P1)

An administrator narrows the list to one actor, one target user, one action, or any combination.

**Why this priority**: Answering "who changed this user" or "what did this admin do" is the main use.

**Independent Test**: Produce records by two admins on two users with different actions; query each
filter alone and combined.

**Acceptance Scenarios**:

1. **Given** records by several actors, **When** filtered by `actorId`, **Then** only that actor's
   records are returned and `total` counts only them.
2. **Given** records on several users, **When** filtered by `targetId`, **Then** only records on that
   user are returned.
3. **Given** several actions, **When** filtered by `action` (`USER_CREATED`, `ROLES_CHANGED`,
   `USER_STATUS_CHANGED`), **Then** only that action is returned.
4. **Given** several filters together, **Then** only records matching all of them are returned.
5. **Given** a well-formed id that matches no user, **Then** the response is 200 with no items.

---

### User Story 3 - Status changes are audited (Priority: P1)

Enabling or disabling a user (US-07) now leaves an audit record like the other admin mutations.

**Why this priority**: Status changes violate constitution XI until this retrofit (migration note).

**Independent Test**: Disable then enable a user; read their audit records; repeat a no-op; make the
audit write fail.

**Acceptance Scenarios**:

1. **Given** an `ACTIVE` user, **When** an admin disables them, **Then** exactly one record exists
   with the actor, `USER_STATUS_CHANGED`, the target, before `ACTIVE` and after `DISABLED`.
2. **Given** a status change to the current status, **When** it is sent, **Then** it still answers as
   in US-07 and no record is written.
3. **Given** the audit write fails, **When** the status change runs, **Then** the status change (and
   any session revocation it implies) is not kept either.

---

### User Story 4 - Records cannot be altered (Priority: P2)

**Why this priority**: A trail that can be edited is not evidence (constitution XI, append-only).

**Independent Test**: Try to update and delete an audit record directly in the database as the
application's own database user.

**Acceptance Scenarios**:

1. **Given** an audit record, **When** anything tries to update or delete it, **Then** the database
   refuses and the record is unchanged.
2. **Given** the service, **Then** no endpoint or code path updates or deletes audit records, and
   inserting new records still works.

---

### User Story 5 - Access and validation (Priority: P2)

**Why this priority**: Only admins may read the trail and bad input must never crash the service.

**Independent Test**: Call with no token, a customer token, a disabled admin's token and invalid
query parameters.

**Acceptance Scenarios**:

1. **Given** no token, a `CUSTOMER` token, or the token of an admin since disabled or demoted,
   **When** `GET /audit` is called, **Then** the response is 401, 403 and the generic 401.
2. **Given** `limit` of 0, above 100, negative or not an integer, a negative or non-integer `offset`,
   an `actorId` or `targetId` that is not a valid id, an unknown `action`, or an unknown query
   parameter, **When** it is sent, **Then** the response is 400 and never 500.

### Edge Cases

- `limit=100` is accepted; `limit=101` is 400.
- A repeated query parameter (e.g. two `action` values) is 400.
- A record whose actor or target was later disabled or demoted is still listed unchanged.
- Records written while a page is read may shift later pages (offset paging; accepted).
- The startup seed writes no record, as before.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST offer `GET /audit`, allowed only to the `ADMIN` role; without a token
  it returns 401, for a `CUSTOMER` token 403.
- **FR-002**: Before reading, the service MUST re-read the caller; if they do not exist, are not
  `ACTIVE` or no longer hold `ADMIN`, it MUST return the generic 401 (as US-07, US-09, US-10).
- **FR-003**: The response MUST be 200 with `items`, `total` (count of all records matching the
  filters), `limit` and `offset` (the values applied).
- **FR-004**: Each item MUST contain exactly `id`, `actorId`, `action`, `targetId`, `before`, `after`
  and `createdAt` (the time the record was written). It MUST NOT contain passwords, hashes, tokens or
  emails; `before` and `after` are returned as stored.
- **FR-005**: Items MUST be ordered by `createdAt` descending, then `id` descending.
- **FR-006**: `limit` MUST default to 20 and be an integer from 1 to 100; `offset` MUST default to 0
  and be an integer ≥ 0.
- **FR-007**: Optional filters `actorId`, `targetId` (valid user ids) and `action` (one of
  `USER_CREATED`, `ROLES_CHANGED`, `USER_STATUS_CHANGED`) MUST combine with AND.
- **FR-008**: Invalid pagination or filter values, repeated or unknown query parameters MUST return
  400 with the existing error format; bad input MUST never cause a 500.
- **FR-009**: `PATCH /users/{id}/status` MUST write one `USER_STATUS_CHANGED` record (actor id, target
  id, before status, after status, time) in the same transaction as the change; if either write
  fails, neither is kept. A no-op MUST write nothing. Its responses are otherwise unchanged.
- **FR-010**: Audit records MUST be append-only: no endpoint or code path updates or deletes them,
  and the database MUST reject UPDATE and DELETE on them for the application's database user.
- **FR-011**: The database protections and the indexes supporting the three filters and the ordering
  MUST be created by a migration (never by schema synchronisation).
- **FR-012**: The README MUST document `GET /audit`, the audited actions and the append-only
  protection; constitution XI's migration note on US-07 MUST be marked resolved.
- **FR-013**: Reads MUST NOT be audited and MUST NOT log record contents.
- **FR-014**: Out of scope: export, deletion or archiving, auditing logins, a UI.

### Key Entities

- **Audit record** (existing, US-09): `id`, `actorId`, `action`, `targetId`, `before`, `after`, time
  written; new action `USER_STATUS_CHANGED` with before and after status.
- **Audit action** (enum): `USER_CREATED`, `ROLES_CHANGED`, `USER_STATUS_CHANGED`.
- **Audit page**: `items`, `total`, `limit`, `offset`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of effective admin mutations (creation, role change, status change) appear in the
  trail exactly once; 0 records for no-ops or failed changes.
- **SC-002**: Paging through the whole trail returns every record exactly once in a stable order.
- **SC-003**: 0 audit records can be changed or removed, through the service or directly in the
  database as the application user.
- **SC-004**: 0 server errors across all tested invalid inputs.
- **SC-005**: 0 trail reads succeed for a caller without a token, with a customer token, or with a
  disabled or demoted admin's token.
- **SC-006**: An admin finds all changes on a given user with a single request.

## Assumptions

- `createdAt` in responses is the record's stored write time (`occurredAt`); no column is renamed.
- Status before/after are stored as `{ "status": "<value>" }`, matching the shape used by US-10 for
  roles.
- Ids in filters must be well-formed UUIDs; a well-formed but unknown id is a valid empty filter.
- The append-only protection is a database trigger raising on UPDATE and DELETE (works whatever role
  the application connects with); the plan may choose a permission rule instead if equivalent.
- Offset pagination is enough at the expected volume; cursor paging is not needed.
- US-07 safeguards, locking and session revocation stay as they are; only the audit write is added.
