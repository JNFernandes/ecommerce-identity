# Implementation Plan: Register a customer account (US-01)

**Branch**: `feature/US-01-register-customer` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-register-customer/spec.md`

## Summary

Public `POST /auth/register` creates a `CUSTOMER` / `ACTIVE` user with a new `customerId`.
The controller validates the DTO and dispatches `RegisterCustomerCommand` (`@nestjs/cqrs`). The handler applies the domain rules (`Email`, `UserName`, `PasswordPolicy`), hashes the password through the `PasswordHasher` port (argon2id), builds the user with `User.registerCustomer` and saves it. Only after that commit does it publish `UserRegistered` through the `UserEventPublisher` port. A failed publish is logged and dead-lettered, and the client still gets 201. Rate limiting is per IP through a named throttler configured from environment variables. Details are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs` (new, ^10.2.7), `@nestjs/throttler` 6, class-validator, `@nestjs/swagger`, TypeORM 0.3, `argon2`, kafkajs (bootstrap `LazyKafkaProducer`)

**Storage**: PostgreSQL. New tables `users` and `outbound_dead_letters`, created by a migration

**Testing**: Jest, Supertest, testcontainers (PostgreSQL, plus `@testcontainers/kafka`, new dev dependency)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: 201 in under 1 s under normal load (SC-001), dominated by one argon2id hash

**Constraints**: 201 within 5 s when Kafka is down (about 3 s with the current Kafka timeouts); no password or hash in any response or log

**Scale/Scope**: one endpoint, one aggregate, two tables, one topic

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | Controller (HTTP and error mapping) → handler (orchestration) → domain (all rules, event raised) → repositories (explicit entity ↔ domain mapping) |
| II. Security | ✅ | argon2id with configurable parameters; password and hash never returned or logged (tested); register is rate limited; CORS unchanged |
| III. Authorization | ✅ | The factory fixes `CUSTOMER` + new `customerId`; unknown body properties give 400; the endpoint is public, as the constitution's table states |
| IV. Write flow | ✅ | Save is committed before publish; no publish when the save fails (unit-tested) |
| V. Types and validation | ✅ | DTO with class-validator plus the global whitelist pipe; enums `Role` and `UserStatus`; no `any`; domain errors mapped in the controller |
| VI/VII. Tests | ✅ | Unit (domain, handler), integration (PostgreSQL migration and index), component (PostgreSQL + Kafka, including Kafka unreachable) |
| VIII. Kafka | ✅ | Envelope + key = `aggregateId`, JSDoc on the event, dead letter with `status`, `retryCount`, `nextRetryAt` and `lastError`; lazy producer; events.md updated (R14) |
| IX. Branching | ✅ | On `feature/US-01-register-customer` |
| X. Quality gate | ✅ | Gate after every task |

Post-design re-check: no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/001-register-customer/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  post-auth-register.md  identity.user-registered.md
```

### Source Code (new or changed)

```text
src/
├── commands/register-customer.command.ts
├── controllers/auth.controller.ts              # POST /auth/register, maps domain errors → 400/409
├── dto/register.dto.ts, register-response.dto.ts
├── domain/
│   ├── role.enum.ts, user-status.enum.ts
│   ├── email.value-object.ts, user-name.value-object.ts, password-policy.ts
│   ├── user.aggregate.ts, events/user-registered.event.ts
│   └── errors/user-validation.error.ts, duplicate-email.error.ts
├── services/
│   ├── register-customer.service.ts            # @CommandHandler
│   └── ports/password-hasher.ts, user-event-publisher.ts
├── repositories/user.repository.ts, outbound-dead-letter.repository.ts, errors/is-unique-violation.ts
├── infra/
│   ├── security/argon2-password-hasher.ts
│   ├── kafka/user-events.producer.ts           # implements UserEventPublisher via LazyKafkaProducer
│   └── database/entities/{user,outbound-dead-letter}.entity.ts, outbound-dead-letter-status.enum.ts
│       migrations/20261117130000-CreateUsersAndOutboundDeadLetters.ts
├── config/configuration.ts                     # + argon2 and rateLimit sections
└── app.module.ts                               # + CqrsModule, ThrottlerModule, TypeOrmModule.forFeature, providers
tests/
├── unit/domain/…, unit/services/register-customer.service.spec.ts, unit/infra/argon2-password-hasher.spec.ts
├── integration/users-migration.integration.spec.ts, user.repository.integration.spec.ts
└── component/register-customer.component.spec.ts, register-kafka-unavailable.component.spec.ts,
    support/{kafka-testing.ts, capturing-logger.ts}
```

**Structure Decision**: The single-project layout of ecommerce-orders, extended with `services/ports/` and `infra/security/` for the two ports (research R3).

### Tests (from the user input)

- **Unit**: `Email` (normalization, invalid, 254-character limit), `UserName` (trim, 1 and 100 accepted, 0 and 101 rejected), `PasswordPolicy` (10 and 128 accepted, 9 and 129 rejected, equal to the email in another case or with spaces rejected), `User.registerCustomer` (`CUSTOMER`, `ACTIVE`, `customerId` ≠ `id`, event fields). Handler: hash called with the password; publish called after save; no publish when save fails; duplicate email propagates `DuplicateEmailError` without publishing; publish failure gives the dead-letter write, the log, and a successful result.
- **Integration**: migration up and down; `lower(email)` unique index rejects `A@x.io` after `a@x.io`; repository maps `23505` to `DuplicateEmailError`; dead-letter row defaults.
- **Component**: 201 (exact response fields, event consumed from Kafka, stored hash starts with `$argon2id$`); 400 for a bad email, a short password, `roles` in the body and an unknown property; 409; 429; Kafka unreachable gives 201 and one `PENDING_RETRY` row. In every case the password is absent from responses and from the captured logs.

### Docs to update

README: the endpoint becomes implemented, a new environment variable table (`ARGON2_*`, `RATE_LIMIT_REGISTER_*`) and a note on the 409 enumeration trade-off. `.env.example`. `ecommerce-infra/docs/events.md` and the `kafka-init` topic list (R14, linked infra change).

## Complexity Tracking

None.
