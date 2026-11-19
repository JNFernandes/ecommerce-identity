# Implementation Plan: An administrator creates a user with a role (US-09)

**Branch**: `feature/US-09-admin-create-user` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-admin-create-user/spec.md`

## Summary

`POST /users` (ADMIN) → `CreateUserCommand` → `CreateUserService`: domain validation
(`Email`, `UserName`, `PasswordPolicy`, `User.createByAdmin` with exactly one role) → argon2id hash →
one `AdminTx` transaction (advisory lock → re-read acting admin → insert user → append
`AuditRecord.userCreated`) → log → `UserEventDispatcher` publishes `identity.user-registered` for a
customer (dead-letter fallback shared with registration). The audit trail starts as a minimal
append-only `audit_records` table guarded by a trigger; US-11 adds the read side. Decisions:
[research.md](research.md).

**Deviations from the input**:
- "or log it" is not an option: a log line is not transactional storage (constitution XI) (R1).
- `UserStatusTx` / `inStatusTransaction` renamed to `AdminTx` / `inAdminTransaction` and reused (R4).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10 (+ CQRS), TypeORM 0.3, `argon2`, `kafkajs` (existing). No new
packages.

**Storage**: PostgreSQL: `users` (unchanged), new `audit_records` (migration + append-only trigger).

**Testing**: Jest; testcontainers PostgreSQL (integration), PostgreSQL + Kafka (component).

**Target Platform**: Linux container / Node 20 server

**Project Type**: web service (NestJS microservice)

**Performance Goals**: one request = one hash + one short transaction; admin traffic is tiny.

**Constraints**: user + audit row atomic; hash outside the transaction; works with Kafka down; no
secrets in logs, responses or audit rows.

**Scale/Scope**: a handful of admin creations per day.

## Constitution Check

| Principle | Status |
|---|---|
| I. Layering | ✅ controller (DTO, error mapping) → service (orchestration) → domain (`User.createByAdmin`, `AuditRecord`) → repository (`AdminTx`) |
| II. Security | ✅ argon2id; registration policy; password never in response/log/audit; generic 401 for a stale admin token |
| III. Authorization & Roles | ✅ `@Roles(ADMIN)`; admins via `POST /users` allowed (1.1.0); one role per user, admins without `customerId`; registration unchanged |
| IV. Write flow | ✅ user + audit committed together, then publish; failed publish dead-lettered, still 201 |
| V. Type safety & validation | ✅ `CreateUserDto` with class-validator; `Role` enum; no `any` |
| VI/VII. Tests | ✅ unit, integration (trigger, atomicity, concurrency), component (Kafka up/down) |
| VIII. Kafka | ✅ same topic and payload as registration, key = user id, lazy producer |
| IX. Branching | ✅ `feature/US-09-admin-create-user`, `feat(US-09)` commits |
| X. Quality gate | ✅ build / lint / format / test after every task |
| XI. Auditability | ✅ append-only `audit_records`, same transaction, no secrets; read endpoint is US-11 |

Post-design re-check: no violations. Known follow-up outside this story: `PATCH /users/{id}/status`
does not audit yet (constitution 1.1.0 migration note).

## Project Structure

### Documentation (this feature)

```text
specs/009-admin-create-user/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/create-user.md
└── tasks.md   (/speckit-tasks)
```

### Source Code

```text
src/
├── domain/
│   ├── user.aggregate.ts                     # + createByAdmin(email, name, hash, roles)
│   └── audit/{audit-action.enum,audit-record}.ts   # NEW
├── commands/create-user.command.ts           # NEW
├── dto/create-user.dto.ts                    # NEW
├── services/
│   ├── create-user.service.ts                # NEW command handler
│   ├── user-event-dispatcher.ts              # NEW, extracted from RegisterCustomerService
│   ├── register-customer.service.ts          # uses the dispatcher
│   └── change-user-status.service.ts         # AdminTx rename only
├── repositories/user.repository.ts           # AdminTx (+ insertUser, appendAudit), rename
├── infra/database/
│   ├── entities/audit-record.entity.ts       # NEW
│   └── migrations/…-CreateAuditRecords.ts    # NEW table + append-only trigger
├── controllers/users.controller.ts           # + POST /users
└── app.module.ts                             # entity + handler + dispatcher

tests/
├── unit/domain/{user.aggregate,audit-record}.spec.ts
├── unit/dto/create-user.dto.spec.ts
├── unit/services/{create-user.service,user-event-dispatcher,register-customer.service}.spec.ts
├── integration/audit-records.integration.spec.ts      # migration, trigger, atomic commit
├── integration/user.repository.integration.spec.ts    # insertUser duplicate / concurrency
└── component/users-create*.component.spec.ts          # endpoint, access, Kafka down, logging

docs: README (endpoint, roles, POST /users section), src/README, ADR 0009 + index,
ecommerce-infra/docs/events.md (event also published for admin-created customers).
```

**Structure Decision**: single NestJS project; new code placed by layer as above.
