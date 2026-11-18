---
description: "Task list for US-06: Seed the first administrator and let admins list users"
---

# Tasks: Seed the first administrator and let admins list users (US-06)

**Input**: `specs/006-admin-seed-list-users/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US5]` are the spec's stories (seed creates the admin / unsafe config is skipped / list users / view one user / admin-only access). All commits use the repo story scope `US-06`.

**Scope notes**:
- One index-only migration (R13). No new package. No Kafka event of any kind (R3, FR-008).
- Configuration problems are logged and skipped; database errors fail startup (R7). The `ADMIN_PASSWORD` value never appears in a log line (R8).
- `@Get('me')` stays declared before `@Get(':id')` (R15). The US-05 `admin-probe.controller.ts` stays (R17).

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup (configuration)

- [X] T001 Add `AdminSeedConfig` (`email?`, `password?`, `name`, JSDoc) and the `admin` block to `src/config/configuration.ts` (R9): `ADMIN_EMAIL` trimmed, empty → `undefined`; `ADMIN_PASSWORD` not trimmed, empty → `undefined`; `ADMIN_NAME` trimmed, empty or unset → `Administrator`. Extend `tests/unit/config/configuration.spec.ts`: all unset, all set, empty strings → `undefined`, whitespace-only email → `undefined`, password with surrounding spaces kept as is, name default. Commit `feat(US-06): add the admin seed configuration`.

---

## Phase 2: Foundational (indexes)

**Purpose**: Indexes for ordered paging and the email prefix (needed by US3/US4 and SC-006).

- [X] T002 Create migration `AddUserListIndexes20261118120000` in `src/infra/database/migrations/20261118120000-AddUserListIndexes.ts` (R13): `up` creates `IDX_users_created_at_id` on `("createdAt" DESC, "id" DESC)` and `IDX_users_email_lower_prefix` on `(lower("email") text_pattern_ops)`; `down` drops both; JSDoc. Integration test `tests/integration/user-list-indexes-migration.integration.spec.ts` (pattern of `users-migration.integration.spec.ts`): both indexes exist after `up` with the expected definitions (`pg_indexes`), both gone after `down`. Commit `feat(US-06): add indexes for listing users`.

**Checkpoint**: Schema ready; no behaviour change.

---

## Phase 3: User Story 1 - First administrator exists after the first start (Priority: P1) 🎯 MVP

**Goal**: With `ADMIN_EMAIL`/`ADMIN_PASSWORD` set and no admin, startup creates exactly one admin who can log in; later starts change nothing.

**Independent Test**: Start on an empty database with the variables set, log in, check `roles: ["ADMIN"]` and no `customerId`; restart with another password; the first still works.

- [X] T003 [P] [US1] Add `static registerAdmin(email: Email, name: UserName, passwordHash: string): User` with JSDoc to `src/domain/user.aggregate.ts` (R3): new id, `customerId: null`, `roles: [ADMIN]`, `status: ACTIVE`, `createdAt = updatedAt = now`, `lastLoginAt: null`, **no** domain event. Extend `tests/unit/domain/user.aggregate.spec.ts`: fields as listed, `pullEvents()` (or the existing event accessor) empty, `canLogin()` true. Commit `feat(US-06): add User.registerAdmin`.
- [X] T004 [P] [US1] Create the `AdminSeedDecision` enum (`PROCEED`, `CREATE`, `SKIP_ADMIN_EXISTS`, `SKIP_NOT_CONFIGURED`, `SKIP_EMAIL_TAKEN`) and `AdminSeedPolicy` with JSDoc in `src/domain/admin-seed-policy.ts` (R2, data-model steps 1–5). It has two methods:
  - `precheck({ adminExists, configured })` → `SKIP_ADMIN_EXISTS` / `SKIP_NOT_CONFIGURED` / `PROCEED`;
  - `decide({ emailOwner })` → `SKIP_EMAIL_TAKEN` / `CREATE`.

  Tests in `tests/unit/domain/admin-seed-policy.spec.ts`: each decision; `adminExists` wins over not configured. Commit `feat(US-06): add AdminSeedPolicy`.
- [X] T005 [P] [US1] Add `existsWithRole(role: Role): Promise<boolean>` with JSDoc to `src/repositories/user.repository.ts` (R5: `:role = ANY(roles)`, `LIMIT 1`, any status). Extend `tests/integration/user.repository.integration.spec.ts`: empty table → false; only customers → false for `ADMIN`; an `ACTIVE` admin → true; a `DISABLED` admin → true. Commit `feat(US-06): add UserRepository.existsWithRole`.
- [X] T006 [US1] Create `AdminSeedService implements OnApplicationBootstrap` with JSDoc in `src/services/admin-seed.service.ts` (R1, R2, R4, R8; depends on T001, T003–T005). It covers the create, admin-exists and not-configured paths; the not-configured path must be included here because every existing component test starts without `ADMIN_*` and must keep starting. The sequence:
  1. read the `admin` config;
  2. call `existsWithRole(ADMIN)`;
  3. call `AdminSeedPolicy.precheck({ adminExists, configured })`. On `SKIP_ADMIN_EXISTS`, return (debug at most). On `SKIP_NOT_CONFIGURED`, log `warn` "no admin exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set" and return;
  4. validate with `Email.create`, `UserName.create` and `PasswordPolicy.assertAcceptable`;
  5. call `findByEmail`, then `AdminSeedPolicy.decide({ emailOwner })`;
  6. on `CREATE`, hash with `PasswordHasher`, build `User.registerAdmin`, call `UserRepository.save` and log `administrator seeded` with the user id only.

  The service branches only on the returned decisions, never on `adminExists` or the config directly (Principle I). It never touches the event producer. Register it in the `src/app.module.ts` providers.

  Tests in `tests/unit/services/admin-seed.service.spec.ts` (mocked repository, hasher and logger):
  - creates an admin with the hash and saves it once;
  - admin exists → the hasher and `save` are never called, and nothing is logged at warn or error;
  - each variable missing or empty → a warning, no validation runs and nothing is saved;
  - no producer dependency is injected;
  - a repository error from `existsWithRole` or `save` propagates. Commit `feat(US-06): seed the first administrator at startup`.
- [X] T007 [US1] Add `useAdminSeed({ email, password, name? } | undefined)` (sets/clears `ADMIN_*` env vars) to `tests/component/support/test-app.ts` and `loginAs(app, email, password)` to `tests/component/support/token-flow.ts`; update the `insertAdminAndLogin` JSDoc (the seed now exists; helper kept for guard tests, R17). Component test `tests/component/admin-seed.component.spec.ts`: empty DB + variables → exactly one `ADMIN` row, `ACTIVE`, `customerId` null, name `Administrator` (and `ADMIN_NAME` honoured in a second case); login 200, decoded access token `roles: ["ADMIN"]` and no `customerId`; second app start on the same DB with a different `ADMIN_PASSWORD` → still one admin, unchanged hash/name/email, old password logs in, new one fails; `TopicObserver` sees no `identity.user-registered` message; with `useUnreachableKafka()` the seed still creates the admin (US1-AS1–AS4). Commit `test(US-06): cover the admin seed end to end`.

**Checkpoint**: MVP — a fresh deployment has a working admin login.

---

## Phase 4: User Story 2 - Unsafe or incomplete seed configuration never breaks startup or data (Priority: P1)

**Goal**: Missing, invalid or conflicting seed values are logged and skipped; no user is ever modified; startup continues.

**Independent Test**: Start with missing variables, a weak password and a customer's email; check logs, health and that no user was created or changed.

- [X] T008 [US2] Complete the remaining skip paths in `src/services/admin-seed.service.ts` (contracts/admin-seed.md; depends on T006; `SKIP_NOT_CONFIGURED` is already done in T006): `UserValidationError` → `error` `ADMIN_<VAR>: <rule>` (variable chosen by which value failed; message never includes the password); `SKIP_EMAIL_TAKEN` → `error` "ADMIN_EMAIL belongs to an existing non-admin user; seed skipped", no `save`; `DuplicateEmailError` from `save` → `warn` "admin already seeded by another instance" (R6). Extend `tests/unit/services/admin-seed.service.spec.ts`: each path logs the right level and message, never calls `save` (except the race), no log argument contains the password; password shorter than 10, longer than 128, equal to the email → error naming the rule; blank `ADMIN_NAME` → `ADMIN_NAME` error; existing admin + missing variables → no warn/error; `ADMIN_EMAIL` in another case with spaces matches the customer (edge case). Commit `feat(US-06): skip the admin seed safely on bad configuration`.
- [X] T009 [US2] Component test `tests/component/admin-seed-misconfig.component.spec.ts` with `tests/component/support/capturing-logger.ts`: no `ADMIN_*` → warn logged, `GET /health` 200, zero users; `ADMIN_PASSWORD=short` → error naming the length rule, no admin; `ADMIN_EMAIL` = an existing customer's email (registered first, then a second app start) → error, customer still `CUSTOMER` with the same hash and data, no admin; two apps started concurrently (`Promise.all` of two `createTestApp` inits) on an empty database with the same `ADMIN_*` → both start and are healthy, exactly one admin row exists, and any loser logged the "already seeded by another instance" warning rather than an error (FR-009); plus a successful seed run; across every run in this file, no captured line contains the password value (FR-007, SC-004). Commit `test(US-06): cover admin seed misconfiguration end to end`.

**Checkpoint**: The seed cannot promote a user or block startup.

---

## Phase 5: User Story 3 - Admin lists and filters users (Priority: P1)

**Goal**: `GET /users` returns a stable, newest-first page with role/status/email-prefix filters and the total.

**Independent Test**: Seed an admin, register customers, call `GET /users` with pages and filters; compare with the stored users.

- [X] T010 [P] [US3] Create `UserSummaryReadModel` and `UserPageReadModel` (data-model.md fields, no hash, no `updatedAt`) in `src/queries/user-summary.read-model.ts` and `ListUsersQuery` (`limit`, `offset`, `role?`, `status?`, `emailPrefix?`) in `src/queries/list-users.query.ts`, all with JSDoc (R10). Types only, no test file (covered by T013/T014). Commit `feat(US-06): add the user listing query and read models`.
- [X] T011 [P] [US3] Create `ListUsersQueryDto` with Swagger (`@ApiPropertyOptional`, enums, bounds, defaults) and JSDoc in `src/dto/list-users-query.dto.ts` (R14): `limit` `@Type(() => Number) @IsInt @Min(1) @Max(100)` default 20; `offset` `@IsInt @Min(0)` default 0; `role` `@IsEnum(Role)`; `status` `@IsEnum(UserStatus)`; `email` `@IsString @MaxLength(254)`, empty → `undefined` via `@Transform`. Tests in `tests/unit/dto/list-users-query.dto.spec.ts` (`plainToInstance` + `validate`): defaults; `limit` 0/101/`1.5`/`abc` rejected, 1 and 100 accepted; `offset` -1 rejected; unknown `role`/`status` rejected; empty email → `undefined`; 255-char email rejected. Commit `feat(US-06): add ListUsersQueryDto`.
- [X] T012 [P] [US3] Create `UserSummaryResponseDto` (`static from(model)`, `customerId` omitted when null, `lastLoginAt` ISO string or `null`, `createdAt` ISO string) in `src/dto/user-summary-response.dto.ts` and `UserPageResponseDto` (`items`, `total`, `limit`, `offset`, `static from(page)`) in `src/dto/user-page-response.dto.ts`, with Swagger and JSDoc (R16). Tests in `tests/unit/dto/user-summary-response.dto.spec.ts`: customer JSON has exactly the 8 keys; admin JSON has no `customerId` key; `lastLoginAt: null` kept; no `password`/`passwordHash`/`updatedAt`; page maps every item. Commit `feat(US-06): add the user summary and page response DTOs`.
- [X] T013 [US3] Add `findPage(query: ListUsersQuery): Promise<UserPageReadModel>` with JSDoc to `src/repositories/user.repository.ts` (R11, R12; depends on T002, T010): one query builder, AND filters (`:role = ANY(roles)`, `status = :status`, `lower(email) LIKE :prefix ESCAPE '\'` with `\`, `%`, `_` escaped and `%` appended), `ORDER BY "createdAt" DESC, id DESC`, `OFFSET`/`LIMIT`, `getManyAndCount`, explicit entity → read model mapping. Extend `tests/integration/user.repository.integration.spec.ts`: newest first; equal `createdAt` ordered by id desc; paging through all users with limit 1, 2 and 3 returns each user exactly once (SC-008); `total` independent of paging; offset past the end → empty items, real total; each filter alone and combined; prefix case-insensitive; `%` and `_` treated literally; read model has no hash. Commit `feat(US-06): add UserRepository.findPage`.
- [X] T014 [US3] Create `ListUsersService` (`@QueryHandler(ListUsersQuery)`, calls `findPage`, returns the page) with JSDoc in `src/services/list-users.service.ts` (depends on T013). Tests in `tests/unit/services/list-users.service.spec.ts`: passes the criteria unchanged, returns the repository result, propagates errors. Commit `feat(US-06): add the ListUsers query handler`.
- [X] T015 [US3] Add `@Get()` `list(@Query() query: ListUsersQueryDto)` with `@Roles(Role.ADMIN)`, `@ApiOkResponse({ type: UserPageResponseDto })`, `@ApiBadRequestResponse` and JSDoc to `src/controllers/users.controller.ts` (maps the DTO to `ListUsersQuery`, `email` → `emailPrefix`, → `UserPageResponseDto.from`); register `ListUsersService` in `src/app.module.ts` (depends on T011, T012, T014). Extend `tests/unit/controllers/users.controller.spec.ts`: dispatches `ListUsersQuery` with the DTO values and returns the mapped DTO. Commit `feat(US-06): add GET /users`.
- [X] T016 [US3] Component test `tests/component/users-list.component.spec.ts` (admin from `useAdminSeed` + `loginAs`, customers via `registerAndLogin`): no params → 200, `limit: 20`, `offset: 0`, newest first, `total` = all users; `limit`/`offset` slice; `role=CUSTOMER`, `status=ACTIVE`, `email=AN` (case-insensitive prefix) and combined filters; offset beyond the end → `items: []`, real `total`; only the admin → one item, `total: 1`; every item has exactly the contract keys, `lastLoginAt` set after a login and `null` before; no `password`/`passwordHash` anywhere in the body (US3-AS1–AS6). Commit `test(US-06): cover GET /users end to end`.

**Checkpoint**: Admins can page and filter users.

---

## Phase 6: User Story 4 - Admin views one user (Priority: P2)

**Goal**: `GET /users/{id}` returns one user in the item shape; 404 when missing, 400 when malformed.

**Independent Test**: Call it with an existing id, an unknown UUID and `abc`.

- [X] T017 [P] [US4] Create `UserNotFoundError` (fixed message `user not found`, JSDoc) in `src/domain/errors/user-not-found.error.ts`. Extend `tests/unit/domain/errors.spec.ts`: name, message, `instanceof Error`. Commit `feat(US-06): add UserNotFoundError`.
- [X] T018 [US4] Add `findSummaryById(id: string): Promise<UserSummaryReadModel | null>` with JSDoc to `src/repositories/user.repository.ts`, reusing the `findPage` entity → read model mapper (depends on T013). Extend `tests/integration/user.repository.integration.spec.ts`: existing id → read model equal to the list item; unknown id → `null`. Commit `feat(US-06): add UserRepository.findSummaryById`.
- [X] T019 [US4] Create `GetUserQuery(id)` in `src/queries/get-user.query.ts` and `GetUserService` (`@QueryHandler`, `findSummaryById`, `null` → `UserNotFoundError`) in `src/services/get-user.service.ts`, with JSDoc (depends on T017, T018). Tests in `tests/unit/services/get-user.service.spec.ts`: returns the read model; missing → `UserNotFoundError`; repository error propagates (not 404). Commit `feat(US-06): add the GetUser query handler`.
- [X] T020 [US4] Add `@Get(':id')` `findOne(@Param('id', ParseUUIDPipe) id)` with `@Roles(Role.ADMIN)`, `@ApiOkResponse`, `@ApiNotFoundResponse`, `@ApiBadRequestResponse` and JSDoc to `src/controllers/users.controller.ts`, declared **after** `@Get('me')`; map `UserNotFoundError` → `NotFoundException('user not found')`; register `GetUserService` in `src/app.module.ts` (R15; depends on T015, T019). Extend `tests/unit/controllers/users.controller.spec.ts`: dispatches `GetUserQuery`, returns the DTO, maps `UserNotFoundError` to 404, other errors propagate. Commit `feat(US-06): add GET /users/{id}`.
- [ ] T021 [US4] Component test `tests/component/users-get.component.spec.ts`: existing id → 200 with the same body as its `GET /users` item; unknown UUID → 404 with `{"statusCode":404,"message":"user not found","error":"Not Found"}`; `abc` → 400 with validation details; admin `GET /users/me` → own account in the US-05 shape (no `lastLoginAt`), not treated as an id (FR-016, US5-AS3). Commit `test(US-06): cover GET /users/{id} end to end`.

---

## Phase 7: User Story 5 - Only admins reach the user endpoints (Priority: P1)

**Goal**: Both endpoints are `ADMIN` only; bad parameters are 400; Swagger documents it.

**Independent Test**: Call both endpoints with no token, an invalid token, a customer token and an admin token.

- [ ] T022 [US5] Component test `tests/component/users-admin-access.component.spec.ts`: no token and `Bearer invalid` → generic US-05 401 (`WWW-Authenticate: Bearer`) on `GET /users` and `GET /users/{id}`; customer token → 403 generic body, no user data; admin → 200; admin with `limit=0`, `limit=101`, `offset=-1`, `limit=abc`, `role=ROOT`, `status=GONE`, `foo=1`, 255-char `email` → 400 with `message` as a string list (FR-015, SC-007). Commit `test(US-06): cover admin-only access and parameter validation`.
- [ ] T023 [US5] Extend `tests/component/swagger-auth.component.spec.ts` on `/docs-json`: `GET /users` and `GET /users/{id}` have bearer `security`, `x-roles: ["ADMIN"]`, 400/401/403 responses (and 404 on `{id}`), the `limit`/`offset`/`role`/`status`/`email` parameters with enums and bounds, and the `UserPageResponseDto`/`UserSummaryResponseDto` schemas without `password`/`passwordHash` (FR-019). Commit `test(US-06): cover the Swagger docs of the user endpoints`.

---

## Phase 8: Polish & cross-cutting

- [ ] T024 [P] Component test `tests/component/users-admin-kafka-unavailable.component.spec.ts`: with `useUnreachableKafka()`, the seeded admin logs in and `GET /users` and `GET /users/{id}` return 200. Commit `test(US-06): cover the admin endpoints with Kafka unreachable`.
- [ ] T025 [P] Integration test `tests/integration/user-list-performance.integration.spec.ts`: insert 10,000 users in bulk, `findPage` with an email prefix filter and with no filter each completes in under 1 s (SC-006). Commit `test(US-06): check user listing stays fast with 10k users`.
- [ ] T026 [P] Update `README.md`: "Admin seed" section (the three variables, the behaviour table from contracts/admin-seed.md, recommend removing `ADMIN_PASSWORD` after the first start), `GET /users` and `GET /users/{id}` under Endpoints and in the access control table, `ADMIN_*` in the environment table (FR-018). Commit `docs(US-06): document the admin seed and user endpoints`.
- [ ] T027 [P] Add commented-out `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME` with a short comment to `.env.example` (FR-018). Commit `docs(US-06): add the admin seed variables to .env.example`.
- [ ] T028 [P] Update `src/README.md` with `AdminSeedService`, `AdminSeedPolicy`, `ListUsersService`, `GetUserService`, the read models and the two endpoints. Commit `docs(US-06): list the admin seed and queries in the module README`.
- [ ] T029 [P] Mark the follow-up in `docs/adr/0003-admin-seed-and-no-role-change.md` as done, pointing to US-06 (no new ADR, R18); update the entry in `docs/adr/README.md` if it carries a status. Commit `docs(US-06): close the ADR 0003 follow-up`.
- [ ] T030 Run `specs/006-admin-seed-list-users/quickstart.md` manually against `npm run start:dev` and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-06): record the manual quickstart run`.

---

## Dependencies & execution order

- **Setup (T001)** → **Foundational (T002)** → stories.
- **US1 (T003–T007)**: T003, T004, T005 in parallel → T006 (needs T001) → T007. MVP.
- **US2 (T008–T009)**: after T006; T008 → T009 (T009 reuses the T007 helpers).
- **US3 (T010–T016)**: after T002; T010, T011, T012 in parallel; T010 → T013 → T014; T011 + T012 + T014 → T015 → T016 (T016 uses T007 helpers).
- **US4 (T017–T021)**: T017 parallel any time; T013 → T018; T017 + T018 → T019; T015 + T019 → T020 → T021.
- **US5 (T022–T023)**: after T020.
- **Polish**: T024–T029 parallel after T023 (T025 only needs T013); T030 last.
- Shared files (sequential tasks): `src/repositories/user.repository.ts` (T005, T013, T018), `src/services/admin-seed.service.ts` (T006, T008), `src/controllers/users.controller.ts` (T015, T020), `src/app.module.ts` (T006, T015, T020), `tests/integration/user.repository.integration.spec.ts` (T005, T013, T018).

```text
T001 → T002
{T003, T004, T005} + T001 → T006 → T007 (US1 MVP)
                            T006 → T008 → T009 (US2)
T002 → T010 → T013 → T014 ─┐
       {T011, T012} ───────┴→ T015 → T016 (US3)
T017 ─┐  T013 → T018 ─┴→ T019 → T020 → T021 (US4)
                                T020 → T022 → T023 (US5)
→ Polish T024..T029 [P] → T030
```

## Parallel examples

- US1: T003 (aggregate), T004 (policy) and T005 (repository) together.
- US3: T010 (read models), T011 (query DTO) and T012 (response DTOs) together; T017 (US4 error) alongside them.
- Polish: T024, T025, T026, T027, T028, T029 in parallel.

## Implementation strategy

1. **MVP**: Phases 1–3 (T001–T007): a fresh deployment has a working admin login.
2. Harden the seed: US2 makes misconfiguration safe and log-clean.
3. US3 delivers the back-office list; US4 adds the detail view; US5 proves admin-only access and Swagger.
4. Polish: Kafka-down, 10k performance, docs, ADR follow-up, manual quickstart.
5. Gate green and commit after every task; open the PR "Implements US-06: Seed the first administrator and let admins list users" after T030.
