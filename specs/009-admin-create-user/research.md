# Research: An administrator creates a user with a role (US-09)

Facts checked on `main` (US-08 and constitution 1.1.0 merged): `User.registerCustomer` records
`UserRegistered` and `User.registerAdmin` records nothing; `RegisterCustomerService` holds the
publish + dead-letter fallback; `ChangeUserStatusService` runs in `UserRepository.inStatusTransaction`
(advisory lock → actor re-read → target `FOR UPDATE`); `UserRepository.save` maps the unique
violation to `DuplicateEmailError`; `toUserSummary` builds the `GET /users/{id}` shape; the global
`ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`; no audit table exists yet.

## R1. Audit storage: a minimal append-only `audit_records` table now
**Decision**: Migration creates `audit_records` (`id`, `actorId`, `action`, `targetId`, `before`
jsonb null, `after` jsonb, `occurredAt`). A trigger rejects every `UPDATE` and `DELETE`; the
repository exposes only `append`. US-11 adds the read side (and any index) on this table.
**Why**: constitution XI needs the record in the same transaction and never changed; a log line is
neither transactional nor storage (spec FR-010). **Rejected**: log only (violates XI); full US-11
table design now (out of scope).

## R2. `action` stored as text, enum only in the domain
**Decision**: Domain enum `AuditAction` (`USER_CREATED` for now); column `varchar(64)`.
**Why**: US-10 and the US-07 follow-up add actions without an enum migration each time.
**Rejected**: PostgreSQL enum (an `ALTER TYPE` per new action).

## R3. No foreign keys from audit rows to users
**Decision**: `actorId` / `targetId` are plain uuids. **Why**: the trail is history and must
outlive any future change to users. **Rejected**: FKs (would couple audit to user lifecycle).

## R4. One admin transaction port, shared with US-07
**Decision**: Rename `UserStatusTx` / `inStatusTransaction` to `AdminTx` / `inAdminTransaction`
and add `insertUser(user)` and `appendAudit(record)`. US-09 runs: advisory lock → re-read actor →
insert user → append audit → commit. **Why**: user and audit row must commit together (FR-010);
the same lock serializes creation with status changes (and US-10 role changes), so the actor check
is exact. The rename is mechanical and prepares the US-07 audit follow-up.
**Rejected**: a separate audit repository taking a raw `EntityManager` (leaks ORM into services);
a second transaction port duplicating the lock.

## R5. Hash before the transaction
**Decision**: Validate and hash (argon2id) before opening the transaction. **Why**: hashing takes
~tens of ms; the advisory lock and a connection must not be held during it. A request that then
fails the actor check or hits 409 has paid the hash, which is acceptable for an admin endpoint.

## R6. Domain owns the role rule and the factory
**Decision**: `User.createByAdmin(email, name, passwordHash, roles)` accepts exactly `[CUSTOMER]`
(delegates to `registerCustomer`, records `UserRegistered`) or `[ADMIN]` (delegates to
`registerAdmin`, no event); anything else throws `UserValidationError`. `AuditRecord.userCreated(
actorId, user, at)` builds the record with `after = { roles }`. The DTO also checks the shape
(`ArrayMinSize(1)`, `ArrayMaxSize(1)`, `IsEnum(Role, { each })`) so bad bodies fail early with 400.
**Why**: constitution I (rules in the domain); one role per user (spec clarification).

## R7. Publish path shared with registration
**Decision**: Extract the publish + log + dead-letter fallback of `RegisterCustomerService` into
`UserEventDispatcher.dispatch(user)` (services layer) and use it in both handlers.
**Why**: identical behaviour required (FR-011); avoids two copies of the fallback.

## R8. Errors and response
**Decision**: `UserValidationError` → 400 (registration message format), `DuplicateEmailError` →
409 `email already registered`, actor missing / not active admin → existing `InvalidAccessTokenError
(USER_UNAVAILABLE)` → generic 401, guard → 401 / 403. Response 201 `UserSummaryResponseDto` via
`toUserSummary`. **Why**: same contracts as US-01 and US-07.

## R9. Logging
**Decision**: after the commit, one `log` line `user created: actorId=… targetId=… roles=…`.
**Why**: FR-012; no email, name, password or token (constitution II).

## R10. Documentation
**Decision**: ADR 0009 (append-only audit table with trigger); README endpoint row → implemented and
a `POST /users` section; `ecommerce-infra/docs/events.md`: `identity.user-registered` is also
published for customers created through `POST /users` (payload unchanged).

## R11. Tests
**Decision**: unit — `User.createByAdmin`, `AuditRecord`, DTO, `CreateUserService` (mocked tx,
dispatcher), `UserEventDispatcher`; integration — migration + trigger blocks update/delete,
`AdminTx.insertUser` + `appendAudit` commit together and roll back together, concurrent duplicate
email → one row; component — 201 admin / customer, event on Kafka, Kafka down → 201 + dead letter,
400 cases, 401 / 403, disabled actor → 401, logs and audit without secrets, US-07 still green.
