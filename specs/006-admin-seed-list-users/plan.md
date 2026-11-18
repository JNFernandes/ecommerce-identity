# Implementation Plan: Seed the first administrator and let admins list users (US-06)

**Branch**: `feature/US-06-admin-seed-list-users` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-admin-seed-list-users/spec.md`

## Summary

**Seed.** `AdminSeedService` (`OnApplicationBootstrap`) runs inside `app.init()`, after migrations and before requests. It reads the `admin` config and then:

1. checks `UserRepository.existsWithRole(ADMIN)`;
2. asks `AdminSeedPolicy.precheck({ adminExists, configured })` and stops unless the answer is `PROCEED` (admin exists → silent; not configured → warn);
3. validates the values with `Email`, `UserName` and `PasswordPolicy`;
4. looks up the email owner;
5. asks `AdminSeedPolicy.decide({ emailOwner })`;
6. on `CREATE`, hashes the password with `PasswordHasher`, builds `User.registerAdmin` (no event) and calls `UserRepository.save`.

Configuration problems are logged and skipped. Database errors fail startup. The password is never logged.

**Read.** `UsersController` gains two routes, both under `@Roles(ADMIN)` and the US-05 guards:

- `GET /users` validates `ListUsersQueryDto`, dispatches `ListUsersQuery` to `ListUsersService` (`@QueryHandler`), which calls `UserRepository.findPage`. The result maps through `UserPageReadModel` to `UserPageResponseDto`.
- `GET /users/{id}` uses `ParseUUIDPipe`, dispatches `GetUserQuery` to `GetUserService`, which calls `findSummaryById`. A missing user raises `UserNotFoundError`, which the controller maps to 404.

One migration adds the indexes for ordered paging and the email prefix. No new package is needed. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `@nestjs/swagger`, `class-validator` / `class-transformer`, TypeORM 0.3, `argon2` (through `PasswordHasher`). No new packages.

**Storage**: PostgreSQL `users`. One index-only migration.

**Testing**: Jest; Supertest; testcontainers (PostgreSQL; Kafka on a closed port)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: A filtered page over 10k users in under 1 s (SC-006), using the `(createdAt DESC, id DESC)` and `lower(email) text_pattern_ops` indexes.

**Constraints**:
- The password is never logged.
- The seed never modifies an existing user and never publishes an event.
- Startup never waits for Kafka.
- 400/401/403/404 semantics per [contracts/admin-users.md](contracts/admin-users.md).

**Scale/Scope**: 2 endpoints, 1 startup service, 2 query handlers, 1 domain policy, 1 factory, 1 error, 1 migration.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | The seed decision (`AdminSeedPolicy`), `User.registerAdmin` and `UserNotFoundError` are in the domain. The services only orchestrate. The repository maps the entity to the read model explicitly. The controller maps errors to HTTP. |
| II. Security | ✅ | The password is stored as an argon2id hash only and never appears in logs (tested). Responses are explicit DTO allow-lists with no hash. Both endpoints are `ADMIN` only. |
| III. Authorization & roles | ✅ | Admins come only from the seed, which runs only when no admin exists. No user is promoted or modified, and no role-changing endpoint is added. `GET /users` is `ADMIN`, as in the constitution table. |
| IV. Write flow | ✅ | The seed commits to PostgreSQL and publishes nothing: admins have no `customerId`, so Orders must not see them. |
| V. Types & validation | ✅ | Typed query DTO (enums, bounds) with `forbidNonWhitelisted`, `ParseUUIDPipe`, typed read models, no `any`. |
| VI/VII. Tests | ✅ | Unit, integration (real PostgreSQL) and component suites, listed below. |
| VIII. Kafka | ✅ | Nothing is published; the seed and the endpoints work with Kafka unreachable. |
| IX. Branching | ✅ | `feature/US-06-admin-seed-list-users`. |
| X. Quality gate | ✅ | The gate runs after every task. |

Post-design re-check: there are no violations and no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/006-admin-seed-list-users/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  admin-users.md  admin-seed.md
```

### Source Code (new or changed)

```text
src/
├── domain/user.aggregate.ts                       # + registerAdmin (R3)
├── domain/admin-seed-policy.ts                    # AdminSeedPolicy + AdminSeedDecision (R2)
├── domain/errors/user-not-found.error.ts
├── config/configuration.ts                        # + admin { email, password, name } (R9)
├── services/admin-seed.service.ts                 # OnApplicationBootstrap (R1, R4–R8)
├── queries/list-users.query.ts, get-user.query.ts
├── queries/user-summary.read-model.ts             # UserSummaryReadModel, UserPageReadModel (R10)
├── services/list-users.service.ts, get-user.service.ts   # @QueryHandler
├── repositories/user.repository.ts                # + existsWithRole, findPage, findSummaryById (R5, R11, R12)
├── infra/database/migrations/20261118120000-AddUserListIndexes.ts   # R13
├── dto/list-users-query.dto.ts                    # R14
├── dto/user-summary-response.dto.ts, user-page-response.dto.ts      # R16
├── controllers/users.controller.ts                # + GET /users, GET /users/:id (R15)
├── app.module.ts                                  # + seed service, handlers
└── README.md                                      # module README
README.md (admin seed section, endpoints, env table), .env.example, docs/adr/0003 follow-up note
```

**Structure Decision**: The single-project layout is kept, following the US-05 query pattern (`queries/` and `services/` handlers).

### Tests

**Unit**

- `AdminSeedPolicy`: each decision, and the order of the checks.
- `User.registerAdmin`: `ADMIN`, `ACTIVE`, no `customerId`, no events.
- `AdminSeedService` (with mocks), covering:
  - it creates an admin (hash used, saved, nothing published);
  - it does nothing when an admin exists, and never calls the hasher or `save`;
  - it skips an existing customer's email (no `save`, error logged);
  - missing variables log a warning;
  - a weak password, or one equal to the email, logs an error without the value;
  - a `DuplicateEmailError` race logs a warning;
  - a repository error propagates.
- `ListUsersService` and `GetUserService`: they map the criteria and the result; a missing user gives `UserNotFoundError`.
- `ListUsersQueryDto`: the defaults, the bounds, enum rejection, an empty email becomes undefined, and email over 254 characters is rejected.
- `UserSummaryResponseDto`: `customerId` is omitted when null; `lastLoginAt` is kept as null.
- `UsersController`: maps 404.
- Config: the `admin` block, empty-string handling and the name default.

**Integration (PostgreSQL)**

`UserRepository`:

- `existsWithRole`;
- `findPage` with each filter and with combined filters, an email prefix that is case-insensitive and treats `%` and `_` literally, `createdAt DESC` ordering with `id` as the tie-break for equal timestamps, pages that neither overlap nor leave gaps, a `total` that is independent of paging, and an offset past the end;
- `findSummaryById`;
- the migration creates and drops both indexes.

**Component**

- Seeding twice leaves exactly one admin, and the second start (with a different password) keeps the first password.
- The admin logs in, and the token has `roles: ["ADMIN"]` and no `customerId`.
- No `user-registered` event is published for the admin.
- The admin lists users (shape, order, filters, `total`) and gets one user (200, 404, and 400 for a malformed id).
- A customer gets 403 and no token gets 401 on both endpoints.
- Bad parameters get 400 with validation details.
- No `password` or `passwordHash` key appears in any response.
- Captured logs contain no `ADMIN_PASSWORD` value across all seed paths (including a weak password).
- With missing variables, startup succeeds and a warning is logged.
- With an existing customer's email, that customer's role is unchanged.

### Docs to update

- **README**:
  - add an "Admin seed" section with the three variables, the behaviour table, and the recommendation to remove `ADMIN_PASSWORD` after the first start;
  - document `GET /users` and `GET /users/{id}` under Endpoints and Access control;
  - add the `ADMIN_*` variables to the environment table.
- **`.env.example`**: add `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME`, commented out.
- **`src/README.md`**: add the seed and the admin queries.
- **ADR 0003**: mark its follow-up done, pointing to this story.

## Complexity Tracking

None.
