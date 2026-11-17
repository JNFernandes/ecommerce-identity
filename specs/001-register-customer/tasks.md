---
description: "Task list for US-01: Register a customer account"
---

# Tasks: Register a customer account (US-01)

**Input**: `specs/001-register-customer/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US3]` are the spec's stories (create / reject / announce). All commits use the repo story scope `US-01`.

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup

- [X] T001 Add `@nestjs/cqrs@^10.2.7` (dependency) and `@testcontainers/kafka@^10.28.0` (dev dependency) in `package.json` / `package-lock.json`; import `CqrsModule` in `src/app.module.ts`. Commit `build(US-01): add @nestjs/cqrs and @testcontainers/kafka`.

---

## Phase 2: Foundational (domain, hasher, persistence)

**Purpose**: Pure domain, the argon2id hasher and the schema. Blocks every story.

### Domain and password policy

- [X] T002 Create enums `Role` (`CUSTOMER`, `ADMIN`) in `src/domain/role.enum.ts` and `UserStatus` (`ACTIVE`, `DISABLED`) in `src/domain/user-status.enum.ts`, and errors `UserValidationError` in `src/domain/errors/user-validation.error.ts` and `DuplicateEmailError` (message `email already registered`) in `src/domain/errors/duplicate-email.error.ts`; JSDoc on each. Unit test `tests/unit/domain/errors.spec.ts` (name, message, `instanceof`). Commit `feat(US-01): add role, status and user domain errors`.
- [ ] T003 [P] Implement `Email` value object (`create(raw)`: trim, lowercase, ≤254 chars, `local@domain.tld`, else `UserValidationError`) in `src/domain/email.value-object.ts`. Tests in `tests/unit/domain/email.value-object.spec.ts`: `" Ana@Example.com "` → `ana@example.com`, invalid formats, 254 accepted, 255 rejected. Commit `feat(US-01): add Email value object`.
- [ ] T004 [P] Implement `UserName` value object (trim, 1–100 code points, else `UserValidationError`) in `src/domain/user-name.value-object.ts`. Tests in `tests/unit/domain/user-name.value-object.spec.ts`: trimmed value, 1 and 100 accepted, empty/whitespace-only and 101 rejected, emoji counted as one code point. Commit `feat(US-01): add UserName value object`.
- [ ] T005 Implement `PasswordPolicy.assertAcceptable(password, email: Email)` (10–128 code points, not trimmed; reject when `password.trim().toLowerCase() === email.value`) in `src/domain/password-policy.ts` (depends on T003). Tests in `tests/unit/domain/password-policy.spec.ts`: 10 and 128 accepted, 9 and 129 rejected, equal to email in other case or with surrounding spaces rejected. Commit `feat(US-01): add password policy`.
- [ ] T006 [P] Create `UserRegistered` domain event (`eventId` UUID, `aggregateId`, `occurredAt` ISO 8601, `version` 1, `customerId`, `email`, `name`; JSDoc on the class and every field, payload documented as in `contracts/identity.user-registered.md`) in `src/domain/events/user-registered.event.ts`. Test in `tests/unit/domain/user-registered.event.spec.ts`: exactly those 7 fields, `version === 1`. Commit `feat(US-01): add UserRegistered domain event`.
- [ ] T007 Implement `User` aggregate in `src/domain/user.aggregate.ts`: `registerCustomer(email, name, passwordHash)` (new `id` and `customerId` via `crypto.randomUUID`, always different, `roles=[CUSTOMER]`, `status=ACTIVE`, timestamps, records `UserRegistered`), `restore(props)` (no event), `pullDomainEvents()` (returns and clears). Depends on T002–T006. Tests in `tests/unit/domain/user.aggregate.spec.ts`: role, status, `customerId ≠ id`, event fields match the user, `restore` raises nothing, second pull is empty. Commit `feat(US-01): add User aggregate`.

### Password hasher

- [ ] T008 [P] Add `PasswordHasher` abstract class (`hash(plain): Promise<string>`, JSDoc) in `src/services/ports/password-hasher.ts`, and an `argon2` section (`ARGON2_MEMORY_COST_KIB` 65536, `ARGON2_TIME_COST` 3, `ARGON2_PARALLELISM` 4) in `src/config/configuration.ts`. Extend `tests/unit/config/configuration.spec.ts` (defaults and overrides). Commit `feat(US-01): add password hasher port and argon2 config`.
- [ ] T009 Implement `Argon2PasswordHasher` (`type: argon2id`, parameters from config, never logs input or output) in `src/infra/security/argon2-password-hasher.ts` (depends on T008). Tests in `tests/unit/infra/argon2-password-hasher.spec.ts` with low parameters: hash starts with `$argon2id$`, encodes the configured `m`/`t`/`p`, `argon2.verify` succeeds, two hashes of one password differ. Commit `feat(US-01): add argon2id password hasher`.

### Migration and repository

- [ ] T010 [P] Create `OutboundDeadLetterStatus` enum (`PENDING_RETRY`, `RESOLVED`, `EXHAUSTED`) in `src/infra/database/entities/outbound-dead-letter-status.enum.ts`, `UserEntity` in `src/infra/database/entities/user.entity.ts` and `OutboundDeadLetterEntity` in `src/infra/database/entities/outbound-dead-letter.entity.ts` as in data-model.md; register both in `src/infra/database/typeorm-options.ts`. Commit `feat(US-01): add user and outbound dead-letter entities`.
- [ ] T011 Write migration `src/infra/database/migrations/20261117130000-CreateUsersAndOutboundDeadLetters.ts` (enums `user_role_enum`, `user_status_enum`, `outbound_dead_letter_status_enum`; tables `users` and `outbound_dead_letters`; unique index `UQ_users_email_lower` on `lower(email)`; unique `customerId`; index `(status, "nextRetryAt")`; full `down`). Depends on T010. Integration test `tests/integration/users-migration.integration.spec.ts` (testcontainers PostgreSQL, same pattern as `baseline-migration.integration.spec.ts`): up/down, `A@x.io` rejected after `a@x.io`, dead-letter defaults (`PENDING_RETRY`, `retryCount` 0, `nextRetryAt` set). Commit `feat(US-01): add users and outbound dead-letter migration`.
- [ ] T012 [P] Add `isUniqueViolation(error)` (PG code `23505`, copied from ecommerce-orders) in `src/repositories/errors/is-unique-violation.ts`. Unit test `tests/unit/repositories/is-unique-violation.spec.ts`. Commit `feat(US-01): add unique-violation helper`.
- [ ] T013 Implement `UserRepository` (`save(user)`, `findById(id)`; explicit `User` ↔ `UserEntity` mapping via `User.restore`; `23505` → `DuplicateEmailError`) in `src/repositories/user.repository.ts`; add `TypeOrmModule.forFeature([UserEntity, OutboundDeadLetterEntity])` and the provider in `src/app.module.ts`. Depends on T007, T011, T012. Integration test `tests/integration/user.repository.integration.spec.ts`: round trip preserves every field, duplicate email in another case throws `DuplicateEmailError`. Commit `feat(US-01): add user repository`.

**Checkpoint**: Domain, hasher and schema ready.

---

## Phase 3: User Story 1 – Create a customer account (P1) 🎯 MVP

**Goal**: `POST /auth/register` creates a `CUSTOMER` / `ACTIVE` user and returns 201 without secrets.

**Independent test**: Register valid data → 201 with exactly `id`, `customerId`, `email`, `name`, `roles`, `createdAt`; stored row is `ACTIVE`, `{CUSTOMER}`, `customerId ≠ id`, hash `$argon2id$…`.

- [ ] T014 [P] [US1] Create `RegisterCustomerCommand` (`email`, `name`, `password`; JSDoc) in `src/commands/register-customer.command.ts`. Commit `feat(US-01): add register customer command`.
- [ ] T015 [P] [US1] Create `RegisterDto` (`@IsString` + `@IsNotEmpty` on `email`, `name`, `password`; `@ApiProperty` with examples) in `src/dto/register.dto.ts` and `RegisterResponseDto` (`id`, `customerId`, `email`, `name`, `roles`, `createdAt`; `@ApiProperty`; static `fromUser(user)`) in `src/dto/register-response.dto.ts`. Unit test `tests/unit/dto/register-response.dto.spec.ts`: `fromUser` returns exactly the 6 keys. Commit `feat(US-01): add register request and response DTOs`.
- [ ] T016 [US1] Implement `RegisterCustomerService` (`@CommandHandler(RegisterCustomerCommand)`: build `Email`, `UserName`, check `PasswordPolicy` **before** hashing, hash, `User.registerCustomer`, `UserRepository.save`, return the `User`) in `src/services/register-customer.service.ts`; provide it and `{ provide: PasswordHasher, useClass: Argon2PasswordHasher }` in `src/app.module.ts`. Depends on T013, T014. Unit tests `tests/unit/services/register-customer.service.spec.ts` with mocked hasher/repository: hasher called once with the plain password, saved user is `CUSTOMER`/`ACTIVE` with the hash, invalid email/name/password throws `UserValidationError` and never calls the hasher or `save`. Commit `feat(US-01): add register customer command handler`.
- [ ] T017 [US1] Implement `AuthController` `POST /auth/register` (`@ApiTags('auth')`, `@HttpCode(201)`, `@ApiCreatedResponse`, dispatch through `CommandBus`, return `RegisterResponseDto.fromUser`) in `src/controllers/auth.controller.ts`; register in `src/app.module.ts`. Depends on T015, T016. Unit test `tests/unit/controllers/auth.controller.spec.ts`: command built from the DTO, response is the mapped DTO. Commit `feat(US-01): add POST /auth/register endpoint`.
- [ ] T018 [US1] Add `tests/component/support/capturing-logger.ts` (a `LoggerService` that stores every line) and `tests/component/register-customer.component.spec.ts` (full app, testcontainers PostgreSQL, migrations run, low argon2 params, `KAFKA_BROKERS` on a closed port as in `health.component.spec.ts` until T027 adds a Kafka container — never the developer's `localhost:9092`): 201 with exactly the 6 fields and email `ana@example.com` for `"Ana@Example.com "`; DB row `ACTIVE`, `{CUSTOMER}`, `customerId ≠ id`, hash starts with `$argon2id$`; no `password`, hash, `accessToken` or `refreshToken` in the body; neither password nor hash in any captured log line. Commit `test(US-01): add register customer component test`.

**Checkpoint**: MVP – a customer can register.

---

## Phase 4: User Story 2 – Reject invalid, duplicate and abusive registrations (P1)

**Goal**: 400 for bad input or privilege attempts, 409 for duplicates, 429 past the per-IP limit; no account created in any of these cases.

**Independent test**: Send each invalid request → expected status and `users` row count unchanged.

- [ ] T019 [US2] Map domain errors in `src/controllers/auth.controller.ts`: `UserValidationError` → `BadRequestException(message)`, `DuplicateEmailError` → `ConflictException('email already registered')`; add `@ApiBadRequestResponse` and `@ApiConflictResponse`. Extend `tests/unit/controllers/auth.controller.spec.ts` (both mappings, other errors rethrown) and `tests/unit/services/register-customer.service.spec.ts` (`DuplicateEmailError` from `save` propagates). Commit `feat(US-01): map registration domain errors to 400 and 409`.
- [ ] T020 [US2] Add a `rateLimit.register` section (`RATE_LIMIT_REGISTER_LIMIT` 5, `RATE_LIMIT_REGISTER_TTL_MS` 60000) in `src/config/configuration.ts`; `ThrottlerModule.forRootAsync` with one named throttler `register` in `src/app.module.ts`; `@UseGuards(ThrottlerGuard)` and `@ApiTooManyRequestsResponse` on the register route only in `src/controllers/auth.controller.ts`. Extend `tests/unit/config/configuration.spec.ts`. Commit `feat(US-01): rate limit registration per client IP`.
- [ ] T021 [P] [US2] Add `tests/component/register-validation.component.spec.ts` (rate limit raised for this suite; `KAFKA_BROKERS` on a closed port with `KAFKA_PRODUCER_RETRIES=0` and a low `KAFKA_CONNECTION_TIMEOUT_MS`, Jest timeout sized for it): 400 for invalid email, password of 9 and 129 chars, password equal to the email (other case, surrounding spaces), empty and 101-char name, `"roles": ["ADMIN"]`, `status`, `id`, `customerId`, an unknown property, malformed JSON, missing field; 10/128-char password and 1/100-char name accepted; 409 `{ statusCode: 409, message: "email already registered", error: "Conflict" }` for `ANA@example.com`; two concurrent registrations of one email → one 201, one 409; `users` count unchanged after each rejection; password absent from captured logs. Commit `test(US-01): add registration rejection component tests`.
- [ ] T022 [P] [US2] Add `tests/component/register-rate-limit.component.spec.ts` (limit 5; Kafka settings as in T021): requests 1–5 processed, the 6th from the same IP gets 429 and creates no account; `GET /health` is never throttled. Commit `test(US-01): add registration rate limit component test`.

**Checkpoint**: Registration is safe against bad input, duplicates, privilege attempts and floods.

---

## Phase 5: User Story 3 – Announce the new customer (P2)

**Goal**: After commit, publish `identity.user-registered`; a failed publish is logged and dead-lettered while the client still gets 201.

**Independent test**: With Kafka up, one event keyed by the user id; with Kafka unreachable, 201 within 5 s and one `PENDING_RETRY` row.

- [ ] T023 [P] [US3] Add `UserEventPublisher` abstract class (`publishUserRegistered(event): Promise<void>`, JSDoc) in `src/services/ports/user-event-publisher.ts`, topic constant `identity.user-registered` in `src/infra/kafka/kafka.constants.ts`, and `UserEventsProducer` (via `LazyKafkaProducer`; key = `aggregateId`; value = JSON of exactly the 7 event fields; rethrows failures) in `src/infra/kafka/user-events.producer.ts`. Unit test `tests/unit/infra/user-events.producer.spec.ts` with a mocked `LazyKafkaProducer`: topic, key, exact payload, error propagates. Commit `feat(US-01): add user registered event producer`.
- [ ] T024 [P] [US3] Implement `OutboundDeadLetterRepository.recordFailure({ eventId, topic, key, payload, error })` (`PENDING_RETRY`, `retryCount` 0, `nextRetryAt` now, `lastError` = error) in `src/repositories/outbound-dead-letter.repository.ts`; provide it in `src/app.module.ts`. Integration test `tests/integration/outbound-dead-letter.repository.integration.spec.ts`: stored row fields and exact payload. Commit `feat(US-01): add outbound dead-letter repository`.
- [ ] T025 [US3] Extend `RegisterCustomerService` in `src/services/register-customer.service.ts`: after `save`, `pullDomainEvents()` and publish; on failure log topic, key, `eventId`, `aggregateId` and cause (never password/hash), then `recordFailure`; if that also fails, log at error level; always return the user. Provide `{ provide: UserEventPublisher, useClass: UserEventsProducer }` in `src/app.module.ts`. Depends on T023, T024. Extend `tests/unit/services/register-customer.service.spec.ts`: publish called after save (call order), no publish and no dead letter when save fails or on `DuplicateEmailError`, publish failure → dead letter with the same `eventId` + log + success, dead-letter failure → still success. Commit `feat(US-01): publish user registered after commit with dead-letter fallback`.
- [ ] T026 [P] [US3] Linked change in `../ecommerce-infra` on branch `feature/US-01-identity-user-registered`: add the `identity.user-registered` entry (fields as in `contracts/identity.user-registered.md`) to `docs/events.md` and the topic to the `kafka-init` topic list. Commit there `docs(US-01): add identity.user-registered event`; run that repo's checks, not this gate.

### Component tests

- [ ] T027 [US3] Add `tests/component/support/kafka-testing.ts` (Orders' `createTopicsWhenReady` plus a consumer helper) and extend `tests/component/register-customer.component.spec.ts` with a Kafka testcontainer (replacing the closed-port brokers from T018): exactly one `identity.user-registered` message, key = user id, payload has exactly the 7 fields matching the response, no `outbound_dead_letters` row. Depends on T025. Commit `test(US-01): assert user registered event in component test`.
- [ ] T028 [US3] Add `tests/component/register-kafka-unavailable.component.spec.ts` (PostgreSQL container, brokers pointing to a closed port): 201 within 5 s; exactly one `PENDING_RETRY` row with `retryCount` 0, `nextRetryAt` and `lastError` set, `eventId` equal to the payload's; a captured log line has topic, key, `eventId` and `aggregateId`; no password or hash in any log. Depends on T025. Commit `test(US-01): cover registration with Kafka unreachable`.

**Checkpoint**: All three stories work and are covered end to end.

---

## Phase 6: Polish & Docs

- [ ] T029 [P] Update `README.md` (`POST /auth/register` implemented, env table for `ARGON2_*` and `RATE_LIMIT_REGISTER_*`, the 409 enumeration trade-off limited by rate limiting) and `.env.example` (same variables with defaults). Commit `docs(US-01): document registration endpoint and settings`.
- [ ] T030 [P] Update `src/README.md` with the new `services/ports/` and `infra/security/` folders and the register write flow. Commit `docs(US-01): describe ports and security layout`.
- [ ] T031 Run `specs/001-register-customer/quickstart.md` scenarios 1–7 against local infra and the final gate; fix anything found (each fix its own commit).

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002–T013)** → stories.
- Foundational chain: T002 → {T003, T004, T006} → T005 (needs T003) → T007; T008 → T009; T010 → T011; {T007, T011, T012} → T013.
- **US1** (T014–T018) needs T009 and T013. **US2** (T019–T022) needs US1's controller (T017). **US3** (T023–T028) needs US1's handler (T016); T023/T024/T026 can start once Foundational is done.
- **Polish** (T029–T031) after all stories.
- Same-file tasks are sequential: `src/app.module.ts` (T001, T013, T016, T017, T020, T024, T025), `auth.controller.ts` (T017, T019, T020), `register-customer.service.ts` (T016, T025), `configuration.ts` (T008, T020).

## Parallel Examples

```text
Foundational: T003 Email | T004 UserName | T006 UserRegistered | T008 hasher port | T010 entities | T012 isUniqueViolation
US1:          T014 command | T015 DTOs
US2:          T021 validation component tests | T022 rate-limit component test (after T020)
US3:          T023 producer | T024 dead-letter repository | T026 ecommerce-infra docs
Polish:       T029 README | T030 src/README
```

## Implementation Strategy

1. **MVP**: T001–T018 → a customer can register (stop and validate with quickstart scenarios 1–3).
2. **Hardening**: T019–T022 → 400/409/429 (scenarios 4–6).
3. **Integration**: T023–T028 → event and dead letter (scenarios 3 and 7).
4. **Docs**: T029–T031, then open the PR "Implements US-01: Register a customer account".
