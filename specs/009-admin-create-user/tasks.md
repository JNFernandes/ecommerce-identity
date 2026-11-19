---
description: "Task list for US-09: An administrator creates a user with a role"
---

# Tasks: An administrator creates a user with a role (US-09)

**Input**: `specs/009-admin-create-user/` (plan.md, spec.md, research.md, data-model.md, contracts/create-user.md, quickstart.md)

**Tests**: Requested (plan R11, constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US5]` are the spec's stories (create an admin / create a customer / invalid input / access control / audit). All commits use the repo story scope `US-09`.

**Scope notes**:
- One role per user: `roles` is exactly `["CUSTOMER"]` or `["ADMIN"]` (spec Clarifications, FR-006).
- Transaction order: hash first (outside) → `lockAdminChanges` → re-read actor → `insertUser` → `appendAudit` → commit → log → dispatch events (R4, R5).
- Audit storage is the new append-only `audit_records` table (trigger); never a log line only (R1).
- No new package. One migration (`audit_records`).

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup

No setup tasks: no package or configuration changes (plan "Technical Context").

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: domain rules, audit storage, the shared admin transaction, the event dispatcher and the request types every story uses.

- [X] T001 [P] Create `AuditAction` enum (`USER_CREATED`) in `src/domain/audit/audit-action.enum.ts` and the immutable `AuditRecord` in `src/domain/audit/audit-record.ts` (data-model "Domain"): fields `id`, `actorId`, `action`, `targetId`, `before: Record<string, unknown> | null`, `after: Record<string, unknown>`, `occurredAt`; factory `AuditRecord.userCreated(actorId: string, user: User, at: Date)` with new `id`, `before = null`, `after = { roles: [...user.roles] }`; JSDoc stating it never holds passwords, hashes or tokens. Tests in `tests/unit/domain/audit-record.spec.ts`: fields for an admin and a customer, `after` holds only `roles` (keys exactly `['roles']`), a copy of the roles (mutating the user later does not change it), new ids differ. Commit `feat(US-09): add the audit record domain value`.
- [X] T002 [P] Add `User.createByAdmin(email: Email, name: UserName, passwordHash: string, roles: readonly Role[]): User` with JSDoc to `src/domain/user.aggregate.ts` (R6): `[Role.CUSTOMER]` → `registerCustomer` (records `UserRegistered`), `[Role.ADMIN]` → `registerAdmin` (no event); empty, both, repeated or more than one role → `UserValidationError('roles must be exactly one of CUSTOMER or ADMIN')`. Extend `tests/unit/domain/user.aggregate.spec.ts`: customer gets `customerId` ≠ `id`, `ACTIVE`, one pulled `UserRegistered` with the contract fields; admin has `customerId` null, `ACTIVE`, no event; `[]`, `[CUSTOMER, ADMIN]`, `[ADMIN, CUSTOMER]`, `[ADMIN, ADMIN]` throw with the exact message. Commit `feat(US-09): add User.createByAdmin`.
- [X] T003 [P] Add migration `src/infra/database/migrations/20261119120000-CreateAuditRecords.ts` and entity `src/infra/database/entities/audit-record.entity.ts` (data-model `audit_records`): columns `id` uuid PK, `actorId` uuid, `action` varchar(64), `targetId` uuid, `before` jsonb null, `after` jsonb not null, `occurredAt` timestamptz; no FKs, no extra index; function + trigger `audit_records_append_only` (`BEFORE UPDATE OR DELETE … FOR EACH ROW`) raising `audit records are append-only`; `down` drops trigger, function, table. Add the entity to `ENTITIES` in `src/infra/database/typeorm-options.ts` and to `TypeOrmModule.forFeature` in `src/app.module.ts`. Tests in new `tests/integration/audit-records-migration.integration.spec.ts` (testcontainers, same setup as `tests/integration/users-migration.integration.spec.ts`): columns and nullability; an inserted row can be read; `UPDATE` and `DELETE` fail with `audit records are append-only` and leave the row; `down` removes table and function. Commit `feat(US-09): add the append-only audit_records table`.
- [X] T004 Rename the admin transaction port in `src/repositories/user.repository.ts` (R4): `UserStatusTx` → `AdminTx`, `inStatusTransaction` → `inAdminTransaction`, `lockStatusChanges` → `lockAdminChanges`, `USER_STATUS_LOCK_KEY` → `ADMIN_CHANGES_LOCK_KEY` (same value), `EntityManagerUserStatusTx` → `EntityManagerAdminTx`; update JSDoc (it now serializes every admin mutation) and every use in `src/services/change-user-status.service.ts`, `tests/unit/services/change-user-status.service.spec.ts`, `tests/integration/user.repository.integration.spec.ts`, `tests/integration/user-status-locking.integration.spec.ts` (search `tests/` and `src/` for the old names). Behaviour unchanged; no new tests. Commit `refactor(US-09): rename the status transaction to the admin transaction`.
- [X] T005 Add `insertUser(user: User): Promise<void>` (maps the unique violation to `DuplicateEmailError`, reusing `UserRepository.toEntity` and `isUniqueViolation`) and `appendAudit(record: AuditRecord): Promise<void>` (insert only) to `AdminTx` / `EntityManagerAdminTx` in `src/repositories/user.repository.ts`, with JSDoc. Depends on T001, T003, T004. Tests in new `tests/integration/admin-tx-create-user.integration.spec.ts`: user and audit row commit together; `work` rejecting after both writes leaves neither; `appendAudit` failing (insert a record whose `id` already exists) rolls the user back; `insertUser` with an existing email (other case) throws `DuplicateEmailError` and nothing is written; two concurrent transactions inserting the same new email → exactly one commits, the other gets `DuplicateEmailError`. Commit `feat(US-09): insert users and audit records in the admin transaction`.
- [X] T006 [P] Extract the publish + log + dead-letter fallback of `src/services/register-customer.service.ts` into `UserEventDispatcher` in `src/services/user-event-dispatcher.ts` (`@Injectable`, JSDoc): `dispatch(user: User): Promise<void>` publishes each pulled event via `UserEventPublisher`, and on failure logs the same `warn` line and calls `OutboundDeadLetterRepository.recordFailure` (same `eventId`), logging an `error` if that fails too; never throws. `RegisterCustomerService` now calls it; register it in `src/app.module.ts`. Move the publish/dead-letter cases from `tests/unit/services/register-customer.service.spec.ts` into new `tests/unit/services/user-event-dispatcher.spec.ts` (publish called once per event; publish failure → warn + `recordFailure` with the exact payload; `recordFailure` failure → error, no throw; no events → nothing called) and keep in the register spec only "save before dispatch" and "dispatch is called with the saved user". Commit `refactor(US-09): extract the user event dispatcher`.
- [X] T007 [P] Create `CreateUserCommand(actingAdminId, email, name, password, roles: Role[])` in `src/commands/create-user.command.ts` and `CreateUserDto` in `src/dto/create-user.dto.ts` (contract "Request"): `email`, `name`, `password` with the same decorators as `src/dto/register.dto.ts`; `roles` `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(1) @IsEnum(Role, { each: true })`; Swagger `@ApiProperty` on every field (`roles` enum array, example `["ADMIN"]`); JSDoc. Tests in `tests/unit/dto/create-user.dto.spec.ts` (`plainToInstance` + `validate` with `whitelist` and `forbidNonWhitelisted`): valid admin and customer bodies pass; missing fields, `roles` `[]`, `["ROOT"]`, `"ADMIN"` (not an array), `["ADMIN","ADMIN"]`, `["CUSTOMER","ADMIN"]` and extra `id` / `customerId` / `status` / `createdAt` fail. Commit `feat(US-09): add CreateUserCommand and CreateUserDto`.

**Checkpoint**: domain, storage, transaction, dispatcher and request types exist and are tested; no endpoint yet.

---

## Phase 3: User Story 1 — Create another administrator (P1) 🎯 MVP

**Goal**: an `ACTIVE` admin creates an `ADMIN` user who can log in at once; no event.

**Independent test**: seeded admin → `POST /users` roles `["ADMIN"]` → 201 without `customerId` → login as the new admin → `GET /users` 200; no message on `identity.user-registered`.

- [X] T008 [US1] Create `CreateUserService` (`@CommandHandler(CreateUserCommand)`, JSDoc) in `src/services/create-user.service.ts` (plan Summary, R4–R9): `Email.create`, `UserName.create`, `PasswordPolicy.assertAcceptable`, `PasswordHasher.hash`, `User.createByAdmin`, then `users.inAdminTransaction(tx => lockAdminChanges → findById(actingAdminId) (missing or `!isActiveAdmin()` → `InvalidAccessTokenError(USER_UNAVAILABLE)`) → insertUser → appendAudit(AuditRecord.userCreated(actor, user, clock.now())))`, then log `user created: actorId=… targetId=… roles=…`, then `UserEventDispatcher.dispatch(user)`; returns `toUserSummary(user)`. Register in `src/app.module.ts`. Tests in `tests/unit/services/create-user.service.spec.ts` (mocked tx, hasher, dispatcher, clock): admin → summary without `customerId`, audit record `USER_CREATED` with `after.roles` `["ADMIN"]`, dispatch called (with no events); customer → `customerId` present, dispatch called with the user holding one `UserRegistered`; call order hash → lock → actor → insert → audit → log → dispatch; invalid email / name / password / roles → `UserValidationError` before hashing and no transaction; actor missing, disabled or not admin → `InvalidAccessTokenError`, no insert; `DuplicateEmailError` from `insertUser` propagates and nothing is logged or dispatched; the log line contains no email, name or password. Commit `feat(US-09): add the create user service`.
- [X] T009 [US1] Add `POST /users` to `src/controllers/users.controller.ts` (contract): `@Post() @HttpCode(201) @Roles(Role.ADMIN)`, `@CurrentUser()` principal → `CreateUserCommand` → `UserSummaryResponseDto`; map `UserValidationError` → `BadRequestException(message)`, `DuplicateEmailError` → `ConflictException('email already registered')` (same as `src/controllers/auth.controller.ts`); `InvalidAccessTokenError` passes through to the existing filter (generic 401). Swagger: `@ApiOperation`, `@ApiCreatedResponse({ type: UserSummaryResponseDto })`, `@ApiBadRequestResponse`, `@ApiConflictResponse`, bearer auth as the other admin routes. Extend `tests/unit/controllers/users.controller.spec.ts` for the error mapping (`UserValidationError` → 400 with its message, `DuplicateEmailError` → 409, other errors rethrown, the command built from the principal and the DTO). Commit `feat(US-09): expose POST /users`.
- [X] T010 [US1] Component test `tests/component/users-create-admin.component.spec.ts` (PostgreSQL + Kafka testcontainers, helpers from `tests/component/support/test-app.ts`, `token-flow.ts`, `kafka-testing.ts`): seeded admin creates `["ADMIN"]` with `"  Bea@Example.COM "` / `"  Bea "` → 201 body exactly `id`, `email: "bea@example.com"`, `name: "Bea"`, `roles: ["ADMIN"]`, `status: "ACTIVE"`, `createdAt`, `lastLoginAt: null`, no `customerId`, no password/hash fields; login as the new admin → 200, token `roles` `["ADMIN"]`, no `customerId`; `GET /users` with that token → 200; no message on `identity.user-registered` after a settle wait. Commit `test(US-09): cover creating an administrator`.

**Checkpoint**: MVP — admins can add admins at runtime.

---

## Phase 4: User Story 2 — Create a customer on someone's behalf (P1)

**Goal**: an admin-created customer is identical to a registered one, including the event.

**Independent test**: `POST /users` roles `["CUSTOMER"]` → 201 with `customerId` → exactly one message, registration payload; with Kafka down → 201 + `PENDING_RETRY` dead-letter row.

- [X] T011 [US2] Component test `tests/component/users-create-customer.component.spec.ts` (PostgreSQL + Kafka): admin creates `["CUSTOMER"]` → 201 with `customerId` ≠ `id`; exactly one message on `identity.user-registered`, key = user id, value keys exactly `eventId`, `aggregateId`, `occurredAt`, `version`, `customerId`, `email`, `name` with the stored values; the customer logs in → token has `customerId`. Commit `test(US-09): cover creating a customer with its event`.
- [ ] T012 [US2] Component test `tests/component/users-create-kafka-unavailable.component.spec.ts` (PostgreSQL only, `useUnreachableKafka()`): `["CUSTOMER"]` → 201, user stored, one `PENDING_RETRY` dead-letter row whose `eventId` equals the payload's `eventId` and whose key is the user id; `["ADMIN"]` → 201 and no dead-letter row; audit rows exist for both. Commit `test(US-09): creation works with Kafka down`.

---

## Phase 5: User Story 3 — Invalid or conflicting input is rejected (P2)

**Goal**: registration rules apply unchanged; the server owns ids, status and `customerId`.

**Independent test**: each invalid body → 400; existing email → 409; nothing written for any of them.

- [ ] T013 [US3] Component test `tests/component/users-create-validation.component.spec.ts` (PostgreSQL, Kafka unreachable): 400 for invalid email, name `"   "`, 101-char name, 9-char and 129-char password, password equal to the email, each missing field, `roles` `[]`, `["ROOT"]`, `["ADMIN","ADMIN"]`, `["CUSTOMER","ADMIN"]`, `["ADMIN","CUSTOMER"]`, extra `id` / `customerId` / `status` / `createdAt`, malformed JSON; 409 for an existing email in another case with spaces, including a `DISABLED` user's email; two concurrent requests with the same new email → one 201, one 409; after all of them: user count and `audit_records` count changed only by the successful creations, no dead-letter rows for failures. Commit `test(US-09): reject invalid and conflicting user creation`.

---

## Phase 6: User Story 4 — Only active administrators can create users (P2)

**Goal**: no token, a customer token or a disabled admin's token never creates a user.

**Independent test**: 401 / 403 / 401 respectively, nothing written.

- [ ] T014 [US4] Component test `tests/component/users-create-access.component.spec.ts` (PostgreSQL, Kafka unreachable): no token → 401; malformed token → 401; customer token → 403; admin created via `POST /users`, then disabled via `PATCH /users/{id}/status` by the seeded admin, then calls `POST /users` with their still-valid token → generic 401; Swagger (`/docs-json`) lists `POST /users` with bearer auth and 201/400/401/403/409. No user or audit row is written by the refused calls. Commit `test(US-09): only active admins can create users`.

---

## Phase 7: User Story 5 — Every creation is audited, never with secrets (P2)

**Goal**: one audit row per creation, atomic with the user, never containing secrets.

**Independent test**: read `audit_records` after creations; capture logs; atomicity covered by T005.

- [ ] T015 [US5] Component test `tests/component/users-create-audit.component.spec.ts` (PostgreSQL, Kafka unreachable, `CapturingLogger`): after creating one admin and one customer, `audit_records` has exactly two rows with the seeded admin's id as `actorId`, `action` `USER_CREATED`, the new ids as `targetId`, `before` null, `after` `{"roles":["ADMIN"]}` / `{"roles":["CUSTOMER"]}`, `occurredAt` within the request time; `UPDATE` / `DELETE` on them fail; captured logs contain one `user created: actorId=… targetId=… roles=…` line per creation and never the passwords, the emails, the names, a hash (`$argon2id$`) or the access token; no response body contains `password` or `passwordHash`. Commit `test(US-09): audit user creation without secrets`.

**Checkpoint**: all stories done.

---

## Phase 8: Polish & cross-cutting

- [ ] T016 [P] Docs in this repo: `README.md` (endpoint row `POST /users` → implemented; Roles section wording without "planned" for `POST /users`; new `### POST /users` section from the contract, one-role rule, audit, the "change your password" advice), `src/README.md` (create-user flow and folders `domain/audit/`), JSDoc of `src/domain/role.enum.ts` (admins come from the seed or `POST /users`) and of `src/domain/events/user-registered.event.ts` (also raised for customers created by an admin). Commit `docs(US-09): document admin user creation`.
- [ ] T017 [P] Add `docs/adr/0009-append-only-audit-table.md` from `docs/adr/template.md` ("Audit records in an append-only table guarded by a trigger": R1–R4, rejected log-only and enum/FK options) and index it in `docs/adr/README.md`. Commit `docs(US-09): add ADR 0009 on the audit table`.
- [ ] T018 [P] In `../ecommerce-infra/docs/events.md`, `identity.user-registered`: also published when an admin creates a customer through `POST /users` on Identity; payload unchanged. Commit in `ecommerce-infra` on a `docs/` branch from its `main` and push it (the user opens the PR).
- [ ] T019 Run `specs/009-admin-create-user/quickstart.md` manually against the local stack and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-09): record the manual quickstart run`.

---

## Dependencies & execution order

- **Foundational (T001–T007)**: T001, T002, T003, T006, T007 in parallel; T004 any time; T005 after T001, T003, T004.
- **US1 (T008–T010)**: T008 needs T002, T005, T006, T007 → T009 → T010. MVP.
- **US2 (T011–T012)**, **US3 (T013)**, **US4 (T014)**, **US5 (T015)**: each after T009; independent of each other (different files).
- **Polish**: T016–T018 parallel after T015; T019 last.
- Shared files (sequential tasks): `src/repositories/user.repository.ts` (T004, T005), `src/app.module.ts` (T003, T006, T008, T009), `src/domain/user.aggregate.ts` (T002), `src/controllers/users.controller.ts` (T009).

```text
{T001, T002, T003, T006, T007} [P] ; T004
T001+T003+T004 → T005
T002+T005+T006+T007 → T008 → T009 → T010 (US1 MVP)
T009 → {T011 → T012 (US2), T013 (US3), T014 (US4), T015 (US5)}
→ Polish {T016, T017, T018} [P] → T019
```

## Parallel examples

- Foundational: T001 (audit value), T002 (aggregate), T003 (migration), T006 (dispatcher), T007 (command + DTO) together.
- After T009: T011, T013, T014, T015 together (separate component spec files).
- Polish: T016, T017, T018 together.

## Implementation strategy

1. **MVP**: T001–T010: admins create admins at runtime, audited atomically.
2. US2 makes admin-created customers first-class (event, Kafka down).
3. US3–US5 prove validation, access control and the audit/no-secrets guarantees.
4. Polish: docs, ADR 0009, infra event note, manual quickstart.
5. Gate green and commit after every task; push the branch after T019 (the user opens the PR).
