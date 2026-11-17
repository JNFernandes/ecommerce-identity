# Feature Specification: Register a customer account (US-01)

**Feature Branch**: `feature/US-01-register-customer`

**Created**: 2026-11-17

**Status**: Draft

**Input**: User description: "US-01: Register a customer account. Anyone can create a customer
account via POST /auth/register with email, name and password; registration never logs the user
in. Always CUSTOMER / ACTIVE with a new customerId; unknown properties rejected; argon2id hash
only; 201 response without secrets; rate limited; save first, then publish
identity.user-registered, dead-lettering a failed publish; works when Kafka is unreachable."

## Clarifications

### Session 2026-11-17

- Q: How is a duplicate email answered? → A: 409 "email already registered"; enumeration risk is an accepted, documented trade-off.
- Q: Password policy beyond length? → A: None: 10–128 characters and different from the email only.
- Q: What is rate limiting keyed by? → A: Client IP.
- Q: Is the name stored as sent or trimmed? → A: Trimmed.
- Q: Event payload shape? → A: Exactly as in `ecommerce-infra/docs/events.md`; no extra fields.
- Q: Any login or admin behaviour in this story? → A: None.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a customer account (Priority: P1)

A visitor submits an email, a name and a password and gets a customer account. The response
confirms the account details, never the password and never any token: logging in is US-02.

**Why this priority**: Without accounts nothing else in Identity (login, tokens, orders tied to a
customer) can exist.

**Independent Test**: Register with valid data and check the 201 response and that the account
exists as `CUSTOMER` / `ACTIVE` with its own `customerId`.

**Acceptance Scenarios**:

1. **Given** no account for `Ana@Example.com `, **When** a visitor registers with that email, name
   "Ana" and a valid password, **Then** the response is 201 with `id`, `customerId`, email
   `ana@example.com`, name, roles `["CUSTOMER"]` and `createdAt`, and nothing else.
2. **Given** a successful registration, **When** the stored account is inspected, **Then** its status
   is `ACTIVE`, its `customerId` is a new UUID different from its `id`, and the password is stored
   only as an argon2id hash.
3. **Given** a successful registration, **When** the response is inspected, **Then** it contains no
   password, no hash, no access token and no refresh token.

---

### User Story 2 - Reject invalid, duplicate and abusive registrations (Priority: P1)

Registration refuses bad input, duplicates, attempts to pick privileges, and floods.

**Why this priority**: Registration is public; without these rules anyone could create admins,
duplicate accounts or flood the service. Security First and Authorization are non-negotiable.

**Independent Test**: Send each invalid request and check the status code and that no account was
created.

**Acceptance Scenarios**:

1. **Given** an account for `ana@example.com`, **When** someone registers `ANA@example.com`,
   **Then** the response is 409 with the generic message "email already registered" and no second
   account exists.
2. **Given** any request body containing `"roles": ["ADMIN"]` (or `status`, `id`, `customerId`, or
   any other unknown property), **When** it is submitted, **Then** the response is 400 and no
   account is created.
3. **Given** an invalid email, a password shorter than 10 or longer than 128 characters, a password
   equal to the email, or a name empty or longer than 100 characters, **When** it is submitted,
   **Then** the response is 400 and no account is created.
4. **Given** the per-IP limit (default 5 requests per minute), **When** a sixth request from the same
   IP arrives within the minute, **Then** the response is 429 and no account is created.

---

### User Story 3 - Announce the new customer to other services (Priority: P2)

After an account is saved, the platform is told about it through `identity.user-registered`, so
Orders can create its customer record (ADR 0004). Registration never depends on Kafka.

**Why this priority**: Other services need the customer, but a messaging outage must not block
sign-ups.

**Independent Test**: Register with Kafka running and observe the event; register with Kafka
unreachable and check 201 plus a stored dead-letter record.

**Acceptance Scenarios**:

1. **Given** Kafka is reachable, **When** a registration succeeds, **Then** exactly one
   `identity.user-registered` event is published after the account is saved, with `eventId`,
   `aggregateId` = user id, `occurredAt`, `version`, `customerId`, `email` and `name`, keyed by the
   user id.
2. **Given** Kafka is unreachable, **When** a visitor registers, **Then** the response is still 201,
   the failure is logged with topic, key, `eventId`, `aggregateId` and cause, and the event is stored in the
   outbound dead-letter table as pending with `retryCount` 0, a `nextRetryAt` and the last error.
3. **Given** the account cannot be saved, **When** a visitor registers, **Then** no event is
   published and no dead-letter record is written.

### Edge Cases

- Two simultaneous registrations with the same email (any case): exactly one gets 201, the other
  409.
- Email with surrounding spaces or upper case: stored and returned trimmed and lowercased.
- Password equal to the email in different case or with surrounding spaces: rejected (compared
  with the normalized email, case-insensitively).
- Password of exactly 10 or 128 characters, name of exactly 1 or 100 characters: accepted.
- Malformed JSON or a missing field: 400.
- The 409 for a duplicate reveals that an email is registered: accepted trade-off, documented in the
  README and limited by rate limiting.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose public `POST /auth/register` accepting exactly `email`, `name`
  and `password`.
- **FR-002**: The system MUST trim and lowercase the email, reject invalid addresses (400), and
  enforce uniqueness case-insensitively, also under concurrent requests.
- **FR-003**: A duplicate email MUST return 409 with the generic message "email already
  registered"; the README MUST document this as an accepted trade-off.
- **FR-004**: The password MUST be 10–128 characters and differ from the email; no other
  composition rule applies. The name MUST be stored trimmed and be 1–100 characters after
  trimming.
- **FR-005**: Any property other than `email`, `name` and `password` MUST be rejected with 400; the
  body can never set roles, status or ids. A test MUST cover `"roles": ["ADMIN"]`.
- **FR-006**: Every account created MUST have role `CUSTOMER`, status `ACTIVE`, a new user id and a
  new `customerId` (UUID, distinct from the user id).
- **FR-007**: The password MUST be hashed with argon2id using configurable parameters; only the
  hash is stored. Neither the password nor the hash may appear in any response or log line.
- **FR-008**: A successful registration MUST return 201 with `id`, `customerId`, `email`, `name`,
  `roles` and `createdAt` only — no password, hash or tokens. Registration MUST NOT log the user
  in.
- **FR-009**: The endpoint MUST be rate limited per client IP with a configurable requests-per-minute
  limit (default 5); excess requests return 429.
- **FR-010**: The account MUST be committed before `identity.user-registered` is published; no
  event is published if the save fails.
- **FR-011**: The event MUST carry `eventId` (UUID), `aggregateId` (user id), `occurredAt` (ISO
  8601), `version` (1), `customerId`, `email` and `name` — exactly these fields, no others — keyed
  by `aggregateId`, and MUST match `ecommerce-infra/docs/events.md`.
- **FR-012**: If publishing fails, the registration MUST still return 201, the error MUST be logged
  with full context (topic, key, `eventId`, `aggregateId`, cause; never password or hash), and the event MUST be
  stored in an outbound dead-letter table with `status`, `retryCount`, `nextRetryAt` and the last
  error, keeping its `eventId`.
- **FR-013**: A schema migration MUST create the users table, with a unique index on the lowercased
  email, and the outbound dead-letter table.
- **FR-014**: Registration MUST work and return 201 when Kafka is unreachable, within the bounded
  publish timeout.

### Key Entities

- **User**: an account. Id, `customerId`, email (normalized, unique), name, password hash, roles
  (`CUSTOMER` here), status (`ACTIVE` here), `createdAt`, `updatedAt`.
- **Outbound dead letter**: an event that could not be published. Event id, topic, key, payload,
  status (pending until US-08 resolves or exhausts it), `retryCount`, `nextRetryAt`, last error,
  timestamps.
- **UserRegistered event**: announces a new customer; envelope plus `customerId`, `email`, `name`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visitor with valid data gets an account in a single request, answered in under 1
  second under normal load.
- **SC-002**: 100% of registrations that try to set roles, status or ids are rejected; no request
  can create a non-`CUSTOMER` account.
- **SC-003**: 0 occurrences of a password or password hash in any response or log line across the
  test suite.
- **SC-004**: With messaging unavailable, 100% of valid registrations still succeed, each within 5
  seconds, and each leaves exactly one pending dead-letter record.
- **SC-005**: Under concurrent duplicate submissions, exactly one account exists per email.
- **SC-006**: From one IP, at most the configured number of registration attempts per minute
  (default 5) are processed; the rest get 429.

## Assumptions

- Lengths are counted in characters (Unicode code points); the password is not trimmed; a name that
  is empty after trimming is rejected.
- Email maximum length is 254 characters (standard limit).
- "Differs from the email" compares the password with the normalized email, case-insensitively.
- The client IP for rate limiting is the direct connection address unless a trusted proxy is
  configured at deployment.
- argon2id parameters default to the library's recommended values and are overridable by
  configuration.
- Dependency: `identity.user-registered` is not yet in `ecommerce-infra/docs/events.md`; this story
  adds it there (and the topic in `kafka-init`) in a linked change.
- Out of scope: login and tokens (US-02), email verification, password reset, admin creation, the
  dead-letter retry worker (US-08).
