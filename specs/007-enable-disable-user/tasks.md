---
description: "Task list for US-07: Enable or disable a user"
---

# Tasks: Enable or disable a user (US-07)

**Input**: `specs/007-enable-disable-user/` (plan.md, spec.md, research.md, data-model.md, contracts/user-status.md, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US6]` are the spec's stories (disable / re-enable / admin safeguards / idempotent / admin-only access and validation / logging). All commits use the repo story scope `US-07`.

**Scope notes**:
- No migration, no new package, no Kafka event (R14, FR-012).
- Transaction order in the handler is fixed: advisory lock → acting admin re-read → target `FOR UPDATE` → domain → (admin target: count + policy) → `saveStatus` → (disable: revoke) (R3, R5, R10).
- Refresh lock order becomes: `findByHash` → `lockUserForShare` → `lockFamily` → `findByHashForUpdate` (R6).
- The last-admin 409 cannot be reached over HTTP: the actor must be an `ACTIVE` admin (FR-016) and is counted, so a disable of another admin always sees a count ≥ 2, and a self-disable gets the self error first. It is covered by unit tests (policy and handler with a mocked count); the race it guards is covered by the integration test in T016.

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup

No setup tasks: no package, configuration or migration changes (plan "Technical Context").

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: errors, input/command types and the transaction port every story uses.

- [X] T001 [P] Create `CannotDisableSelfError` (message `an admin cannot disable their own account`) in `src/domain/errors/cannot-disable-self.error.ts` and `LastActiveAdminError` (message `the last active admin cannot be disabled`) in `src/domain/errors/last-active-admin.error.ts`, with JSDoc; generalize the JSDoc of `src/domain/errors/user-not-found.error.ts` (no longer only for `GET /users/{id}`) (R11). Extend `tests/unit/domain/errors.spec.ts`: name, exact message, `instanceof Error` for both. Commit `feat(US-07): add the status-change domain errors`.
- [X] T002 [P] Create `ChangeUserStatusDto` in `src/dto/change-user-status.dto.ts`: `status` required, `@IsEnum(UserStatus)`, `@ApiProperty({ enum: UserStatus })`, JSDoc; no other field (R12). Tests in `tests/unit/dto/change-user-status.dto.spec.ts` (`plainToInstance` + `validate` with `whitelist` and `forbidNonWhitelisted`): `ACTIVE` and `DISABLED` accepted; missing, `disabled`, `"ENABLED"`, `1`, `null` and an extra field `x` rejected. Commit `feat(US-07): add ChangeUserStatusDto`.
- [X] T003 [P] Create `ChangeUserStatusCommand(targetId: string, status: UserStatus, actingAdminId: string)` with JSDoc in `src/commands/change-user-status.command.ts` (data-model). Types only, no test file (covered by T008). Commit `feat(US-07): add ChangeUserStatusCommand`.
- [ ] T004 Add the `UserStatusTx` interface and `inStatusTransaction<T>(work: (tx: UserStatusTx) => Promise<T>): Promise<T>` to `src/repositories/user.repository.ts`, with JSDoc stating the lock order, mirroring `RefreshTokenRepository.inTransaction` (R9). `UserStatusTx` methods (data-model table): `lockStatusChanges()` (`SELECT pg_advisory_xact_lock(<exported constant key>)`), `findById(id)`, `findByIdForUpdate(id)` (`FOR UPDATE`), `countActiveAdmins()` (`status = 'ACTIVE' AND 'ADMIN' = ANY(roles)`), `saveStatus(user)` (updates only `status` and `updatedAt`), `revokeAllRefreshTokens(userId, at)` (`"revokedAt" IS NULL` rows only, returns the count). Extend `tests/integration/user.repository.integration.spec.ts`: `findByIdForUpdate` maps to the aggregate and returns `null` for an unknown id; `countActiveAdmins` ignores customers and `DISABLED` admins; `saveStatus` leaves email, name, roles, hash and `lastLoginAt` unchanged; `revokeAllRefreshTokens` revokes every family of the user, leaves other users' tokens alone, keeps `revokedAt`/`replacedBy` of already-revoked rows and returns the number revoked; a rejected `work` rolls back; a second `inStatusTransaction` calling `lockStatusChanges` blocks until the first commits (resolve-order check). Commit `feat(US-07): add the user status transaction port`.

**Checkpoint**: T001–T004 done → stories can start.

---

## Phase 3: User Story 1 - Admin disables a user and cuts off their sessions (Priority: P1) 🎯 MVP

**Goal**: `PATCH /users/{id}/status {"status":"DISABLED"}` disables the user and revokes every refresh token atomically; login, refresh and `/users/me` then refuse with 401.

**Independent Test**: Register and log in a customer (keep its refresh token), disable it as an admin, then try login, refresh and `GET /users/me`.

- [ ] T005 [P] [US1] Add `disable(actingAdminId: string, at: Date): boolean` and `isActiveAdmin(): boolean` with JSDoc to `src/domain/user.aggregate.ts` (R1, data-model): `disable` throws `CannotDisableSelfError` when `id === actingAdminId` (checked before the status), returns `false` with no change when already `DISABLED`, else sets `DISABLED` and `updatedAt = at` and returns `true`. Extend `tests/unit/domain/user.aggregate.spec.ts`: change, no-op, self throws even when already disabled, `updatedAt` set only on change, email/name/roles/hash/`lastLoginAt` untouched, `canLogin()` false after; `isActiveAdmin` for active admin, disabled admin and customer. Commit `feat(US-07): add User.disable and isActiveAdmin`.
- [ ] T006 [P] [US1] Add `lockUserForShare(userId: string): Promise<void>` (`SELECT 1 FROM users WHERE id = $1 FOR SHARE`) to `RefreshTokenTx` / `EntityManagerRefreshTokenTx` in `src/repositories/refresh-token.repository.ts` and update the lock-order JSDoc; call it in `RefreshService.attempt` in `src/services/refresh.service.ts` right after `findByHash` and before `lockFamily` (R6). Extend `tests/unit/services/refresh.service.spec.ts` (call order `findByHash` → `lockUserForShare` → `lockFamily`; not called for an unknown hash) and `tests/integration/refresh-token-locking.integration.spec.ts` (a transaction holding the user row `FOR UPDATE` blocks `lockUserForShare` until it commits). Commit `fix(US-07): lock the user row during refresh`.
- [ ] T007 [P] [US1] Make `saveWithLogin` in `src/repositories/refresh-token.repository.ts` update `lastLoginAt` only `WHERE id = $1 AND status = 'ACTIVE'`; when 0 rows are affected, throw `InvalidCredentialsError` before inserting the token (R7); update its JSDoc. Extend `tests/integration/refresh-token.repository.integration.spec.ts`: active user → token inserted and `lastLoginAt` set; disabled user → `InvalidCredentialsError`, no token row, `lastLoginAt` unchanged. Check `tests/unit/services/login.service.spec.ts` still passes (the error propagates as the generic login failure). Commit `fix(US-07): refuse to store a login for a disabled user`.
- [ ] T008 [US1] Create `ChangeUserStatusService` (`@CommandHandler(ChangeUserStatusCommand)`, deps `UserRepository`, `Clock`, `Logger`) with JSDoc in `src/services/change-user-status.service.ts` (R5, R8, R10, R13; depends on T001, T003, T004, T005). In one `inStatusTransaction`: `lockStatusChanges` → `findById(actingAdminId)`, missing or not `ACTIVE` → throw `InvalidAccessTokenError(USER_UNAVAILABLE)` → `findByIdForUpdate(targetId)`, `null` → `UserNotFoundError` → for `DISABLED`: `user.disable(actingAdminId, now)`; if changed → `saveStatus` then `revokeAllRefreshTokens`. After the commit, an effective change logs `user status changed: actorId=… targetId=… from=… to=… revokedTokens=N`; return a `UserSummaryReadModel` built from the updated aggregate (same fields as `findSummaryById`; reuse or export the mapper). For `ACTIVE`, return the summary unchanged with no write (the enable path is added in T013). Tests in `tests/unit/services/change-user-status.service.spec.ts` (fake `UserStatusTx` recording calls): disable → `saveStatus` + `revokeAllRefreshTokens`, one log line with the count; call order lock → actor → target; actor missing / `DISABLED` → `InvalidAccessTokenError`, no target read, no write; unknown target → `UserNotFoundError`, no write; already disabled → no write, no log; self → `CannotDisableSelfError`, no write; result fields match the aggregate; log line contains no email. Commit `feat(US-07): add the ChangeUserStatus command handler`.
- [ ] T009 [US1] Add `@Patch(':id/status')` `changeStatus(@Param('id', ParseUUIDPipe) id, @Body() dto: ChangeUserStatusDto, @CurrentUser() principal)` with `@Roles(Role.ADMIN)`, `@HttpCode(200)`, `@ApiOkResponse({ type: UserSummaryResponseDto })`, `@ApiBadRequestResponse`, `@ApiNotFoundResponse`, `@ApiConflictResponse` and JSDoc to `src/controllers/users.controller.ts`: dispatch `ChangeUserStatusCommand(id, dto.status, principal sub)`, return `UserSummaryResponseDto.from`, map `UserNotFoundError` → `NotFoundException('user not found')`; register `ChangeUserStatusService` in `src/app.module.ts` (R11; depends on T002, T008). Extend `tests/unit/controllers/users.controller.spec.ts`: dispatches the command with the principal's id, returns the DTO, maps `UserNotFoundError` to 404, other errors propagate. Commit `feat(US-07): add PATCH /users/{id}/status`.
- [ ] T010 [US1] Component test `tests/component/users-status-disable.component.spec.ts` (admin from `useAdminSeed` + `loginAs`, customer from `registerAndLogin`; customer logged in twice for two families): disable → 200, body equals `GET /users/{id}` with `status: DISABLED`; every `refresh_tokens` row of the customer has `revokedAt` (via `familyRows`/SQL); login with correct password → generic 401 body identical to a wrong-password 401; old refresh tokens → generic refresh 401; `GET /users/me` with the customer's access token → 401; a user with no tokens can be disabled (US1-AS1–AS5, SC-001, SC-002). Commit `test(US-07): cover disabling a user end to end`.
- [ ] T011 [US1] Integration test `tests/integration/user-status-locking.integration.spec.ts` (real `UserRepository`, `RefreshTokenRepository`, `ChangeUserStatusService`, `RefreshService` on testcontainers PostgreSQL): a refresh transaction paused after `lockUserForShare` plus a concurrent disable → the disable waits; after both finish, no unrevoked token of the user exists (or the refresh was refused); a login whose `saveWithLogin` runs after the disable commits inserts no token (edge case "refresh in flight", R6, R7). Commit `test(US-07): cover refresh and login racing a disable`.

**Checkpoint**: an admin can disable a customer and every session of that customer is dead.

---

## Phase 4: User Story 2 - Admin re-enables a user (Priority: P1)

**Goal**: `{"status":"ACTIVE"}` restores login; revoked tokens stay revoked.

**Independent Test**: Disable a user, enable it, try an old refresh token (401), then log in (200).

- [ ] T012 [P] [US2] Add `enable(at: Date): boolean` with JSDoc to `src/domain/user.aggregate.ts` (R1): already `ACTIVE` → `false`, no change; else `ACTIVE`, `updatedAt = at`, `true`. Extend `tests/unit/domain/user.aggregate.spec.ts`: change, no-op, `updatedAt`, other fields untouched, `canLogin()` true after. Commit `feat(US-07): add User.enable`.
- [ ] T013 [US2] Handle `ACTIVE` in `src/services/change-user-status.service.ts` (depends on T008, T012): `user.enable(now)`; if changed → `saveStatus` only (never `revokeAllRefreshTokens`); log `from=DISABLED to=ACTIVE revokedTokens=0`. Extend `tests/unit/services/change-user-status.service.spec.ts`: enable writes status, no revocation, one log line; enable on active → no write, no log; admin enabling themself → 200 path, no error. Commit `feat(US-07): re-enable users`.
- [ ] T014 [US2] Component test `tests/component/users-status-enable.component.spec.ts`: disable then enable a customer → 200 `status: ACTIVE`; refresh token revoked by the disable → generic 401; login → 200 and the new refresh token works (US2-AS1–AS3, SC-007). Commit `test(US-07): cover re-enabling a user end to end`.

**Checkpoint**: disable and enable both work.

---

## Phase 5: User Story 3 - Safeguards keep at least one admin able to act (Priority: P1)

**Goal**: no self-disable, never 0 `ACTIVE` admins, a disabled admin's token cannot change statuses.

**Independent Test**: An admin tries to disable itself; two admins disable each other concurrently.

- [ ] T015 [P] [US3] Create `LastActiveAdminPolicy.assertCanDisable({ target: User; activeAdminCount: number }): void` with JSDoc in `src/domain/last-active-admin-policy.ts` (R2). Tests in `tests/unit/domain/last-active-admin-policy.spec.ts`: active admin with count 1 or 0 → `LastActiveAdminError`; count 2 → ok; customer or disabled admin target with count 1 → ok. Commit `feat(US-07): add LastActiveAdminPolicy`.
- [ ] T016 [US3] In `src/services/change-user-status.service.ts`, for `DISABLED` on a target where `isActiveAdmin()` was true before the change: call `user.disable` first (self error wins), then `countActiveAdmins()` and `LastActiveAdminPolicy.assertCanDisable` before `saveStatus` (R2; depends on T013, T015). Extend `tests/unit/services/change-user-status.service.spec.ts`: admin target with count 1 → `LastActiveAdminError`, no write; count 2 → disabled; self on the last admin → `CannotDisableSelfError` (not last-admin); customer target → `countActiveAdmins` not called. Extend `tests/integration/user-status-locking.integration.spec.ts`: two `ACTIVE` admins disable each other via `Promise.all` of two `execute` calls → no deadlock error, exactly one succeeds, the other rejects with `InvalidAccessTokenError`, exactly one `ACTIVE` admin remains; repeat 20 times (FR-009, SC-003). Commit `feat(US-07): never disable the last active admin`.
- [ ] T017 [US3] Map `CannotDisableSelfError` and `LastActiveAdminError` to `ConflictException` with their messages in `changeStatus` in `src/controllers/users.controller.ts` (R11; depends on T009, T016). Extend `tests/unit/controllers/users.controller.spec.ts`: each error → 409 with the exact contract message. Commit `feat(US-07): return 409 for the admin safeguards`.
- [ ] T018 [US3] Component test `tests/component/users-status-safeguards.component.spec.ts` (seeded admin A via `useAdminSeed` + `loginAs`, second admin B via `insertAdminAndLogin`): A disables A → 409 self message, A still `ACTIVE`; A enables A → 200 no change; A disables B → 200; B's still-valid token on `PATCH` (any target, including enabling B) → generic 401, nothing changes; A re-enables B → 200; concurrent A→B and B→A → one 200 and one 401, exactly one `ACTIVE` admin in the database (US3-AS1, AS3–AS5, SC-008). Commit `test(US-07): cover the admin safeguards end to end`.

**Checkpoint**: admins cannot lock themselves out.

---

## Phase 6: User Story 5 - Only admins can change status, with clear errors (Priority: P1)

**Goal**: US-05 guards and input validation; no input produces a 500; Swagger documents it.

**Independent Test**: Call the endpoint with no token, an invalid token, a customer token, an unknown id, a malformed id and invalid bodies.

- [ ] T019 [US5] Component test `tests/component/users-status-access.component.spec.ts`: no token and `Bearer invalid` → generic US-05 401 with `WWW-Authenticate: Bearer`; customer token → generic 403 and target unchanged; unknown UUID → 404 `{"statusCode":404,"message":"user not found","error":"Not Found"}`; `abc` id → 400; bodies `{}`, `{"status":"disabled"}`, `{"status":1}`, `{"status":null}`, `{"status":"DISABLED","x":1}` and malformed JSON → 400 with `message` details, never 5xx (US5-AS1–AS4, FR-010, SC-004, SC-005). Commit `test(US-07): cover access control and validation of the status endpoint`.
- [ ] T020 [US5] Extend `tests/component/swagger-auth.component.spec.ts` on `/docs-json`: `PATCH /users/{id}/status` has bearer `security`, `x-roles: ["ADMIN"]`, the `ChangeUserStatusDto` request schema with the `ACTIVE`/`DISABLED` enum, a 200 `UserSummaryResponseDto` response and 400/401/403/404/409 responses (FR-014). Commit `test(US-07): cover the Swagger docs of the status endpoint`.

---

## Phase 7: User Story 4 - Repeated requests are harmless (Priority: P2)

**Goal**: setting the current status returns 200 and writes nothing.

**Independent Test**: Disable twice and enable an active user; compare rows, tokens and logs.

- [ ] T021 [US4] Component test `tests/component/users-status-idempotent.component.spec.ts` (with `tests/component/support/capturing-logger.ts`): `DISABLED` twice → both 200, `updatedAt` unchanged by the second, one `user status changed` line in total; `ACTIVE` on an active customer → 200, `updatedAt` unchanged, its refresh token rows unchanged and still usable, no status-change line (US4-AS1–AS2, FR-005). Commit `test(US-07): cover idempotent status requests`.

---

## Phase 8: User Story 6 - Every change leaves a trace (Priority: P2)

**Goal**: one log line per effective change; no secrets in any line.

**Independent Test**: Disable and enable a user and inspect the captured logs.

- [ ] T022 [US6] Component test `tests/component/users-status-logging.component.spec.ts` (`capturing-logger.ts`): disable then enable → exactly two `user status changed` lines with the admin's id as `actorId`, the target id, `from`/`to` in order, and `revokedTokens` matching the revoked rows; across every request in the file (including 400/401/403/409 cases), no captured line contains the customer's or admin's email, a password, an access or refresh token value or `Authorization` (US6-AS1–AS2, FR-011, SC-006). Commit `test(US-07): cover status change logging`.

---

## Phase 9: Polish & cross-cutting

- [ ] T023 [P] Component test `tests/component/users-status-kafka-unavailable.component.spec.ts`: with `useUnreachableKafka()`, disable → 200, login 401, enable → 200, login 200; no `identity.*` publish is attempted for these calls (FR-012). Commit `test(US-07): cover the status endpoint with Kafka unreachable`.
- [ ] T024 [P] Update `README.md`: `PATCH /users/{id}/status` under Endpoints (body, responses, safeguards, idempotency), a row in the access control table, and in Session trade-offs: a disabled user's access tokens stay valid on token-only routes until `exp` (≤ `JWT_ACCESS_TTL_SECONDS`), while `/users/me`, login, refresh and this endpoint refuse at once (FR-013). Commit `docs(US-07): document enabling and disabling users`.
- [ ] T025 [P] Update `src/README.md` with `ChangeUserStatusService`, `LastActiveAdminPolicy`, `UserStatusTx`, the status-change lock order and the new refresh lock order (R3, R6). Commit `docs(US-07): describe the status flow in the module README`.
- [ ] T026 [P] Add `docs/adr/0006-status-changes-serialized-and-sessions-revoked.md` from `docs/adr/template.md` ("Status changes are serialized; disabling revokes sessions; access tokens expire naturally": R3 with the rejected row-lock order, R6, R7, the access-token trade-off) and index it in `docs/adr/README.md` (R15). Commit `docs(US-07): add ADR 0006 on status changes`.
- [ ] T027 Run `specs/007-enable-disable-user/quickstart.md` manually against `npm run start:dev` and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-07): record the manual quickstart run`.

---

## Dependencies & execution order

- **Foundational (T001–T004)** → stories. T001, T002, T003 in parallel; T004 any time (independent file).
- **US1 (T005–T011)**: T005, T006, T007 in parallel → T008 (needs T001, T003, T004, T005) → T009 (needs T002) → T010; T011 after T006, T007, T008. MVP.
- **US2 (T012–T014)**: T012 parallel with US1 work; T008 + T012 → T013 → T014.
- **US3 (T015–T018)**: T015 parallel any time; T013 + T015 → T016 → T017 → T018.
- **US5 (T019–T020)**: after T017 (needs the final controller).
- **US4 (T021)** and **US6 (T022)**: after T016.
- **Polish**: T023–T026 parallel after T022; T027 last.
- Shared files (sequential tasks): `src/domain/user.aggregate.ts` (T005, T012), `src/services/change-user-status.service.ts` (T008, T013, T016), `src/controllers/users.controller.ts` (T009, T017), `src/repositories/refresh-token.repository.ts` (T006, T007), `tests/unit/services/change-user-status.service.spec.ts` (T008, T013, T016), `tests/integration/user-status-locking.integration.spec.ts` (T011, T016).

```text
{T001, T002, T003, T004} [P]
T005 ─┐
T004 ─┴→ T008 → T009 → T010 (US1 MVP)
T006, T007 ──→ T011
T012 ─→ T013 (US2) → T014
T015 ─→ T016 (US3) → T017 → T018 → T019 → T020 (US5)
        T016 → T021 (US4), T022 (US6)
→ Polish T023..T026 [P] → T027
```

## Parallel examples

- Foundational: T001 (errors), T002 (DTO), T003 (command), T004 (repository port) together.
- US1: T005 (aggregate), T006 (refresh lock) and T007 (login guard) together; T012 and T015 can join them (different files).
- Polish: T023, T024, T025, T026 together.

## Implementation strategy

1. **MVP**: T001–T011: admins can disable a user and every session dies (race-safe).
2. US2 adds the way back; US3 adds the self and last-admin safeguards and the actor re-check under concurrency.
3. US5 proves admin-only access, validation and Swagger; US4 and US6 prove idempotency and logging.
4. Polish: Kafka-down, docs, ADR 0006, manual quickstart.
5. Gate green and commit after every task; push the branch after T027 (the user opens the PR).
