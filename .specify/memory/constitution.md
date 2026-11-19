<!--
SYNC IMPACT REPORT
==================
Version change:    1.1.2 → 1.1.3 (2026-11-19)
Bump rationale:    PATCH: settles the two password change TODOs (US-12); clarifies Principle II
                   without adding a new kind of rule.

Settled TODOs:
  - TODO(CURRENT_SESSION) — a password change revokes every refresh token of the user, the
    caller's included, and returns a new pair (new family) to the caller in the login shape.
  - TODO(PASSWORD_CHANGE_RATE_LIMIT) — `POST /users/me/password` is rate limited per user id and
    client IP (default 5 per minute, `RATE_LIMIT_PASSWORD_CHANGE_*`); excess gets 429.

Runtime guidance:
  ✅ README.md — endpoint, rate limit variables and the access-token trade-off documented.
  ✅ src/README.md — password change flow documented.

=============================================================================================
Previous report (1.1.2)
=============================================================================================
Version change:    1.1.1 → 1.1.2 (2026-11-19)
Bump rationale:    PATCH: the 1.1.0 migration note on US-07 is resolved; no rule changes.

Resolved migration notes:
  ✅ `PATCH /users/{id}/status` (US-07) writes a `USER_STATUS_CHANGED` record in the same
    transaction (fix/US-07); verified end-to-end with `GET /audit` (US-11).

Runtime guidance:
  ✅ README.md — `GET /audit`, audited actions and the append-only trigger documented.

=============================================================================================
Previous report (1.1.1)
=============================================================================================
Version change:    1.1.0 → 1.1.1 (2026-11-19)
Bump rationale:    PATCH: clarifies Principle III for users holding both roles (US-10); no rule is
                   added or removed.

Modified principles:
  - II. Security First — `customerId` claim only when the roles include `CUSTOMER`.
  - III. Authorization & Roles — admins created by the seed or `POST /users` have no `customerId`;
    a user may hold `CUSTOMER` and `ADMIN`; the first `CUSTOMER` grant creates a `customerId` and
    publishes `identity.user-registered`; removing `CUSTOMER` keeps it dormant (never in a token).

Settled TODOs:
  - TODO(ROLE_CHANGE_CUSTOMER_ID) — settled as above (US-10, ADR 0010).

Runtime guidance:
  ✅ README.md — `PUT /users/{id}/roles` documented.
  ✅ docs/adr/0010-role-changes-keep-customer-id-and-share-the-admin-lock.md — added and indexed.

=============================================================================================
Previous report (1.1.0)
=============================================================================================
Version change:    1.0.0 → 1.1.0 (2026-11-19)
Bump rationale:    MINOR, as requested by the maintainer: a new principle (XI. Auditability) is
                   added and Principle III is materially expanded (role changes and admin creation
                   through the API, password change). Note: the policy below lists "redefinition of
                   an existing principle" as MAJOR, and the rule "no endpoint may change a user's
                   role" is replaced, not only extended. The maintainer chose MINOR because no
                   existing behaviour is removed or broken: every current endpoint keeps working
                   and the change only adds capabilities.

Modified principles:
  - I. Domain-Driven Design & Layered Architecture — `AuditRecord` added (append-only).
  - II. Security First — new "Password change" and "Admin-created users" rules.
  - III. Authorization & Roles — "No endpoint may change a user's role" replaced: roles change only
    through `PUT /users/{id}/roles` by an `ADMIN`; never self-service; a user cannot remove their
    own `ADMIN` role; the last `ACTIVE` admin can never lose `ADMIN` or be disabled. `ADMIN` users
    come from the startup seed or from `POST /users` by an `ADMIN`. Endpoint table: added
    `POST /users`, `PUT /users/{id}/roles`, `GET /audit`, `POST /users/me/password`, and the
    already implemented `GET /users/{id}` (missing from 1.0.0).
  - IV. Write Flow Integrity — audit record written in the same transaction as the change.
  - VI. Test Coverage — password change, role-change rules and audit atomicity added to the
    security-critical tests.

Added sections:
  - XI. Auditability

Removed sections:
  - Out of Scope: "Changing roles through the API" removed. "Password reset" clarified as the
    forgotten-password flow (changing one's own password with the current one is in scope).

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates derive from this file at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; no mandatory section added or removed.
  ✅ .specify/templates/tasks-template.md — Phase/story structure compatible; audit tests fit existing test tasks.
  ✅ .specify/templates/commands/*.md     — Directory not present in this project; nothing to update.

Runtime guidance:
  ✅ CLAUDE.md — security, write flow and out-of-scope bullets updated.
  ✅ README.md — roles, endpoints (planned rows) and admin seed wording updated.
  ✅ docs/adr/0008-admin-creation-and-role-changes-through-the-api.md — added; supersedes 0003.
     (The request named ADR 0005, but 0005 is "Default-deny route guards" and ADR numbers are
     never reused; 0008 is the next free number.)
  ✅ docs/adr/0003-admin-seed-and-no-role-change.md — status "Superseded by 0008"; kept.
  ✅ docs/adr/README.md — index updated.
  ⚠ src/domain/role.enum.ts — JSDoc still says admins come only from the seed; true until the
    `POST /users` story lands, update it there.

Migration note (existing code that must change):
  ✅ RESOLVED in 1.1.2 (US-11): `PATCH /users/{id}/status` (US-07) now writes its audit record
    in the same transaction.

Deferred TODOs (to settle in the specs of the stories that implement them):
  - TODO(ADMIN_CREATED_CUSTOMER): whether `POST /users` may create a `CUSTOMER` and, if so, that it
    gets a `customerId` and publishes `identity.user-registered` like registration.
  - TODO(ROLE_CHANGE_CUSTOMER_ID): what happens to `customerId` when a role set gains or loses
    `CUSTOMER`, and whether a role change raises an event. (Settled in 1.1.1.)
  - TODO(CURRENT_SESSION): how "all other sessions" is determined on password change (the access
    token carries no refresh-token family). (Settled in 1.1.3.)
  - TODO(PASSWORD_CHANGE_RATE_LIMIT): `POST /users/me/password` checks a password and is a
    guessing target; rate limiting it is recommended but not yet required. (Settled in 1.1.3.)

=============================================================================================
Previous report (1.0.0)
=============================================================================================
Version change:    (template) → 1.0.0
Bump rationale:    Initial ratification. The placeholder template is replaced by a full
                   constitution modelled on ecommerce-orders v1.2.0 (structure, wording, section
                   order) with the producer failure handling and startup resilience wording of
                   ecommerce-inventory v1.1.2, adapted to an identity service.

Modified principles (template placeholder → new title):
  - [PRINCIPLE_1_NAME] → I. Domain-Driven Design & Layered Architecture
  - [PRINCIPLE_2_NAME] → II. Security First (NON-NEGOTIABLE)
  - [PRINCIPLE_3_NAME] → III. Authorization & Roles (NON-NEGOTIABLE)
  - [PRINCIPLE_4_NAME] → IV. Write Flow Integrity (NON-NEGOTIABLE)
  - [PRINCIPLE_5_NAME] → V. Type Safety & Input Validation

Added sections:
  - Principles VI. Test Coverage, VII. Testing Strategy, VIII. Kafka Events (Producer),
    IX. Branching Strategy, X. Build & Code Quality Integrity (NON-NEGOTIABLE)
  - Technology Stack (was [SECTION_2_NAME])
  - Out of Scope
  - Documentation Standards (was [SECTION_3_NAME])
  - Governance (filled)

Removed sections:
  - (none)

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates derive from this file at runtime; no static change needed.
  ✅ .specify/templates/spec-template.md  — Generic structure; no mandatory section added or removed.
  ✅ .specify/templates/tasks-template.md — Phase/story structure compatible; security tests fit existing test tasks.
  ✅ .specify/templates/commands/*.md     — Directory not present in this project; nothing to update.

Runtime guidance:
  ⚠ README.md — not present yet. MUST be created with the first story and MUST state that HTTPS
    is required outside local development and document the development key pair script.
  ⚠ CLAUDE.md — not present yet; create it aligned with this version.
  ⚠ docs/adr/ — not present yet; create the index and template with the first ADR.

Cross-repository follow-ups (ecommerce-infra):
  ⚠ docs/events.md — add topic `identity.user-registered` (published by Identity, status
    planned) with its payload (`customerId`, `email`, `name`).
  ⚠ docker-compose.yml — add the `identity` PostgreSQL database on localhost:5435
    (`identity_user` / `identity_pass`) and the `identity.user-registered` topic in `kafka-init`.

Deferred TODOs:
  (none)
-->

# ecommerce-identity Constitution

## Core Principles

### I. Domain-Driven Design & Layered Architecture

The codebase MUST follow a strict four-layer model: **Controller → Service → Domain → Repository**.

- **Controllers** handle HTTP I/O only — routing, deserialization, and response shaping. No logic.
- **Services** orchestrate workflows and coordinate domain objects and repositories. They MUST NOT contain business rules.
- **Domain** is the sole home of all business logic. Entities, value objects, aggregates, and domain events live here.
- **Repositories** abstract persistence. They MUST NOT leak ORM internals into domain objects.
  TypeORM entities are separate classes from domain objects and are mapped explicitly in the
  infrastructure layer.

Aggregates:
- `User` — `id`, `customerId`, `email`, `name`, `passwordHash`, `roles`, `status`, timestamps
  (`createdAt`, `updatedAt`).
- `RefreshToken` — `id`, `userId`, `familyId`, `tokenHash`, `expiresAt`, `revokedAt`,
  `replacedBy`.
- `AuditRecord` — `id`, `actorId`, `action`, `targetId`, `before`, `after`, `occurredAt`;
  append-only (Principle XI).

The domain event `UserRegistered` is raised by the domain and published by infrastructure.
Placing business logic in controllers or services is a constitutional violation and MUST be rejected in code review.

### II. Security First (NON-NEGOTIABLE)

This service owns credentials and issues the tokens every other service trusts. Every rule below
is mandatory.

**Passwords:**
- Passwords MUST be hashed with **argon2id**; its parameters (memory, iterations, parallelism)
  MUST be configurable.
- A password MUST NEVER be logged, returned in any response, or stored in clear text.

**Login:**
- Every login failure (unknown email, wrong password, disabled user) MUST return one and the same
  generic error, so that the response never reveals whether an email exists (no user
  enumeration).
- Password checks MUST use constant-time comparison. When the email is unknown, the service MUST
  still perform a hash verification against a dummy hash so that the response time does not
  reveal whether the user exists.

**Password change (`POST /users/me/password`):**
- The request MUST include the current password; it is verified like a login (argon2id,
  constant-time) and a wrong current password fails the request without changing anything.
- The new password MUST satisfy the registration password policy.
- A successful change MUST revoke every other session of the user. Since an access token names no
  refresh-token family, every refresh token of the user is revoked and the caller gets a new pair
  (new family) in the same transaction as the new hash. Access tokens already issued stay valid
  until they expire.
- The endpoint MUST be rate limited per user id and client IP; excess requests get 429.

**Admin-created users (`POST /users`):**
- The user gets the password the admin supplies. It MUST satisfy the registration password policy,
  is stored only as an argon2id hash, and MUST NOT be logged, returned or written to an audit
  record.
- Trade-off (documented in the README): the admin knows that password, so the README MUST
  recommend that the user changes it with `POST /users/me/password` after the first login.

**Access tokens:**
- Access tokens are JWTs signed with **RS256**. They MUST be short-lived: 15 minutes by default,
  configurable.
- Claims MUST be exactly: `sub` (user id), `customerId` (only when `roles` include `CUSTOMER`), `roles`, `iss`, `aud`,
  `iat`, `exp`, `jti`. The JWT header MUST carry `kid`.
- The private key MUST come from the environment or a mounted file and MUST NEVER be committed.
  A development key pair is generated by a documented script and its output is git-ignored.
- `GET /.well-known/jwks.json` MUST publish the public keys with their `kid` and MUST support
  more than one active key at a time so keys can be rotated without invalidating live tokens.

**Refresh tokens:**
- Refresh tokens are opaque random values with **at least 256 bits of entropy**. They MUST be
  stored only as a hash, never in clear.
- A refresh token is single use: every refresh MUST revoke the presented token and issue a new
  one in the same family (rotation).
- Presenting a refresh token that has already been used MUST revoke the whole token family
  (reuse detection) and fail the request.
- Refresh token lifetime MUST be configurable.

**Request handling:**
- `POST /auth/register` and `POST /auth/login` MUST be rate limited; exceeding the limit returns
  `429`.
- Tokens, passwords and `Authorization` headers MUST NOT appear in logs.
- Every input MUST be validated (Principle V).
- CORS allowed origins MUST come only from the `CORS_ALLOWED_ORIGINS` environment variable.
  Wildcards and hard-coded origins are prohibited.
- The README MUST state that HTTPS is required outside local development.

### III. Authorization & Roles (NON-NEGOTIABLE)

**Roles:**
- There are exactly two roles, stored as the `Role` enum: `CUSTOMER` and `ADMIN`.
- Public registration MUST always create a `CUSTOMER` with a new `customerId`; a role in the
  request is never honoured.
- `ADMIN` users MUST be created only (a) by the startup seed from the `ADMIN_EMAIL` and
  `ADMIN_PASSWORD` environment variables when no admin exists, or (b) by an `ADMIN` through
  `POST /users`. Admins created this way have no `customerId`.
- A user MAY hold both roles. The first time `CUSTOMER` is granted to a user without
  `customerId`, a new one is created and `identity.user-registered` is published (as for
  registration). Removing `CUSTOMER` keeps the `customerId`, dormant: it is never put in a token
  while the roles lack `CUSTOMER`, and a later grant reuses it without a new event.
- A user's roles MUST change only through `PUT /users/{id}/roles`, called by an `ADMIN`. Role
  changes are never self-service: no other endpoint, and no `CUSTOMER`, can change a role.
- A user MUST NOT remove their own `ADMIN` role.
- The last `ACTIVE` admin MUST never lose the `ADMIN` role and MUST never be disabled. These
  checks MUST be race-safe (two concurrent requests cannot together remove the last admin).

**Tokens and current state:**
- Access tokens carry `roles` and, when the roles include `CUSTOMER`, `customerId`.
- Role changes and user disabling take effect for access tokens only when those tokens expire.
  Login and refresh MUST check the user's current `status` and `roles` and MUST refuse a
  disabled user.

**Endpoint protection:**
- Endpoints are protected by guards driven by the `roles` claim of a verified access token.
- Every non-public endpoint MUST declare the roles allowed. An endpoint without a declaration
  is a constitutional violation.

| Endpoint | Access |
|----------|--------|
| `POST /auth/register` | public |
| `POST /auth/login` | public |
| `POST /auth/refresh` | public (refresh token required) |
| `POST /auth/logout` | public (refresh token required) |
| `GET /.well-known/jwks.json` | public |
| `GET /users/me` | `CUSTOMER`, `ADMIN` |
| `POST /users/me/password` | `CUSTOMER`, `ADMIN` |
| `GET /users` | `ADMIN` |
| `POST /users` | `ADMIN` |
| `GET /users/{id}` | `ADMIN` |
| `PATCH /users/{id}/status` | `ADMIN` |
| `PUT /users/{id}/roles` | `ADMIN` |
| `GET /audit` | `ADMIN` |

**Rules for services that verify tokens (platform-wide):**
- They MUST verify the signature against the JWKS, and `iss`, `aud` and `exp`.
- They MUST take `customerId` from the verified token and MUST NOT trust a `customerId` sent by
  the client.
- A customer asking for a resource owned by someone else MUST get `404`.

### IV. Write Flow Integrity (NON-NEGOTIABLE)

The write flow MUST follow this exact sequence and MUST NOT deviate:

1. Controller receives and validates request (via DTO).
2. Service delegates to the Domain layer.
3. Domain executes business logic and raises domain events.
4. Repository persists state to **PostgreSQL first**.
5. **Only after** a successful commit: publish `identity.user-registered`.

Publishing to Kafka before a committed database save is a critical violation. If the DB save fails, no Kafka message MUST be emitted. Services are responsible for enforcing this order. `UserStatus` transitions are only final once persisted.

An administrative mutation (Principle XI) MUST write its audit record in the same transaction as
the change: if either fails, neither is committed.

Refresh token rotation MUST be atomic: revoking the presented token and storing its replacement
happen in a single transaction, and two concurrent refreshes with the same token MUST NOT both
succeed.

### V. Type Safety & Input Validation

All code MUST be strictly typed — the `any` TypeScript type is **banned** without exception.

- Every external input boundary (REST body, query params, path params) MUST be represented as a DTO class decorated with `class-validator` and `class-transformer`.
- DTOs are validation contracts. Skipping validation on any input boundary is a constitutional violation.
- Domain objects MUST use TypeScript types and interfaces — no implicit `any`, no type assertions that widen to `unknown` or `any`.
- The `Role` and `UserStatus` enums MUST be used for all role and status fields — bare string literals are prohibited.

All errors MUST use NestJS built-in exceptions (NotFoundException, BadRequestException, UnauthorizedException, etc.).
Domain errors MUST be mapped to HTTP status codes at the controller layer, never in the domain.
Unhandled promise rejections MUST be caught — no swallowed errors, no silent failures.

### VI. Test Coverage

All domain logic and services MUST have unit tests.

- Every service method and Domain method MUST have at least one unit test covering the happy path and at least one covering an error/edge case.
- Domain tests MUST NOT depend on NestJS DI, databases, or Kafka — pure unit tests only.
- Service tests MAY use lightweight mocks for repositories and the event publisher.
- Each of the following security-critical behaviours MUST have its own tests: password hashing,
  access token claims and expiry, refresh token rotation, reuse detection, the generic login
  error, rate limiting, role guards, password change (wrong current password, policy, other
  sessions revoked), the role-change rules (no self-removal of `ADMIN`, last active admin), and
  audit records (written in the same transaction, never containing secrets).
- Tests are not optional: a PR that adds a service or domain method without corresponding tests MUST NOT be merged.

### VII. Testing Strategy

Three test layers are required:

- **Unit tests** — domain logic and services in isolation. No NestJS, no DB, no Kafka.
- **Integration tests** — REST endpoints and repositories. Real PostgreSQL via testcontainers. Test happy path, errors, and edge cases.
- **Component tests** — full NestJS app with real PostgreSQL and real Kafka via testcontainers. Tests the complete write flow (REST → DB → Kafka emitted) and the token flows (register → login → refresh → logout).

Tools: Jest, Supertest, @nestjs/testing, testcontainers (PostgreSQL, Kafka).
Minimum coverage: 80% on domain and application layers.
Test names MUST describe the behaviour: "should revoke the whole token family when a used refresh token is presented".

### VIII. Kafka Events (Producer)

Kafka is the event bus between services. This service only **produces** events.
`ecommerce-infra/docs/events.md` is the source of truth for every topic and payload.

**Produced topics:**
- `identity.user-registered`

**Event publishing rules:**
- Events MUST only be published after a committed PostgreSQL save (see Principle IV).
- Each domain event maps to exactly one Kafka topic.

**Event payload rules:**
- Every event MUST include: `eventId` (UUID), `occurredAt` (ISO timestamp), `aggregateId` (UUID of
  the producing aggregate), and `version` (integer).
- For `identity.*` events, `aggregateId` is the **user id**.
- `identity.user-registered` additionally carries `customerId`, `email` and `name`.
- The Kafka message key MUST be the event's `aggregateId`.
- Payloads MUST be serialized as JSON.
- Breaking changes to a payload schema require a new topic version (e.g. `identity.user-registered.v2`).
- Event classes MUST be documented with JSDoc describing every field and MUST match
  `ecommerce-infra/docs/events.md`.

**Producer failure handling:**
- If publishing fails after the DB commit, the error MUST be logged with full context (topic,
  key, `eventId`, `aggregateId`, cause) and the event MUST be stored in an outbound dead-letter
  table with `status`, `retryCount`, `nextRetryAt` and the last error.
- A scheduled retry worker MUST claim due rows with `SELECT … FOR UPDATE SKIP LOCKED`, republish
  with the **same** `eventId`, back off exponentially, and mark each row `RESOLVED` or `EXHAUSTED`.
- Delivery is **at-least-once**; consumers downstream rely on `eventId` for deduplication.
- The service MUST NOT throw a 500 to the client for Kafka publish failures — the DB save already succeeded.

**Startup resilience:**
- The service MUST start and report healthy when Kafka is unreachable: no broker connection is
  required at boot and the producer connects lazily. Kafka unavailability MUST NOT fail the
  application bootstrap.

### IX. Branching Strategy

This project follows a **feature-branch workflow** tied to user stories, identical to
ecommerce-orders.

**Branch naming convention:**
- Feature branches: `feature/US-XX-short-description`
- Bug fixes: `fix/US-XX-short-description`
- Infrastructure: `chore/short-description`

Examples:
- `feature/US-01-register-user`
- `feature/US-02-login`
- `feature/US-03-refresh-token`

**Rules:**
- `main` is always production-ready — never commit directly to main.
- Every user story gets its own branch created from `main`.
- Branch MUST be created before any implementation begins.
- Each branch maps to exactly one user story.
- PRs MUST reference the user story: "Implements US-01: Register a user".
- Branches MUST be deleted after merge.
- Commit messages MUST follow Conventional Commits:
  `feat(US-01): add register user service`
  `test(US-01): add unit tests for user aggregate`
  `docs(US-01): add JSDoc to user registered event`

**Automated branch creation (MANDATORY):**
When /speckit.specify is invoked for a user story, Claude Code MUST:
1. Ensure the working tree is clean (no uncommitted changes)
2. Checkout main and pull latest: `git checkout main && git pull`
3. Create and checkout the feature branch: `git checkout -b feature/US-XX-short-description`
4. Only then proceed with generating the spec

The branch MUST exist before any spec file is written.
Claude Code MUST NOT generate spec files while on main.

### X. Build & Code Quality Integrity (NON-NEGOTIABLE)

The project MUST compile and pass all quality checks at all times.

**After every task implementation, Claude Code MUST run in this order:**

1. `npm run build`        — TypeScript compilation MUST pass
2. `npm run lint`         — ESLint MUST pass with zero errors
3. `npm run format:check` — Prettier formatting MUST be consistent
4. `npm run test`         — all existing tests MUST still pass

**Rules:**
- If any of the above fails, Claude Code MUST fix it before
  moving to the next task.
- A failing build, lint error, or formatting violation
  MUST never be committed to the branch.
- TypeScript compilation errors are blocking issues — not warnings, not deferred items.
- `npm run lint` runs with `--max-warnings 0`, so lint warnings are blocking as well as errors.
- Claude Code MUST NOT mark a task as complete until
  all four checks pass.

### XI. Auditability

Every administrative mutation MUST leave a permanent, tamper-evident trace of who changed what.

**What is audited:**
- Administrative mutations: user creation by an admin (`POST /users`), role change
  (`PUT /users/{id}/roles`) and status change (`PATCH /users/{id}/status`). The startup seed has
  no actor and is not audited.

**Audit records:**
- Each mutation MUST write one audit record with `actorId` (the admin), `action`, `targetId`
  (the user changed), `before`, `after` and a timestamp.
- The record MUST be written in the same transaction as the change (Principle IV): a change
  without its record, or a record without its change, is never committed.
- Audit records are append-only: they MUST NEVER be updated or deleted, by the API or by the
  application code.
- `before` and `after` MUST NEVER contain a password, a password hash or a token.

**Access:**
- Audit records are readable only by `ADMIN` through `GET /audit`. No other endpoint returns them.

**Tooling:**
- Linter: ESLint with @typescript-eslint rules
- Formatter: Prettier
- Build: TypeScript compiler via NestJS build
- Tests: Jest

**ESLint rules (minimum):**
- @typescript-eslint/no-explicit-any — error (enforces Principle V)
- @typescript-eslint/explicit-function-return-type — error
- @typescript-eslint/no-unused-vars — error
- prettier/prettier — error

**Configuration files required:**
- ESLint config (`eslint.config.mjs` or `.eslintrc.js`)
- `.prettierrc` — Prettier config
- `tsconfig.json` — strict mode enabled
  (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`)

## Technology Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 20+ + TypeScript |
| Framework | NestJS |
| REST API docs | Swagger / OpenAPI (auto-generated from NestJS decorators) |
| Persistence | TypeORM + PostgreSQL |
| Token signing & JWKS | `jose` (RS256) |
| Password hashing | `argon2` (argon2id) |
| Rate limiting | `@nestjs/throttler` |
| Messaging | Kafka via `kafkajs` |
| Validation | `class-validator` + `class-transformer` |
| Testing | Jest, Supertest, `@nestjs/testing`, testcontainers (PostgreSQL, Kafka) |
| Containerization | Docker (multi-stage `Dockerfile`) |
| HTTP port | `PORT` environment variable, default `3001` (`3000` is Orders, `8080` is Kafka UI) |
| Local infrastructure | ecommerce-infra (docker compose): PostgreSQL `localhost:5435`, database `identity`, user `identity_user` / `identity_pass` (to be added to ecommerce-infra); Kafka `localhost:9092` |

Introducing a new runtime dependency that duplicates a capability already provided by the stack above requires an ADR in `docs/adr/` before the PR can be merged.

## Out of Scope

The following are out of scope for the whole service unless this constitution is amended:

- Email verification
- Password reset (the forgotten-password flow; changing one's own password with the current one
  is in scope, Principle II)
- Social login
- Multi-factor authentication
- User profile editing

A spec that requires any of them MUST NOT be planned until an amendment is merged.

## Documentation Standards

All public classes, methods, and interfaces MUST carry JSDoc comments.
Swagger/OpenAPI annotations MUST be present on all REST endpoints and DTOs so that the spec is auto-generated without manual editing; protected endpoints MUST declare their bearer authentication.
Kafka event payloads MUST be documented (field names, types, semantics) in the event class JSDoc and in `ecommerce-infra/docs/events.md`.
That documentation MUST stay consistent with the platform-wide contract in
`ecommerce-infra/docs/events.md`: a payload change updates both in the same change, and a
discrepancy is a defect.
Each NestJS module MUST include a `README.md` describing its responsibility, exposed endpoints, and domain events it produces.
The repository `README.md` MUST state that HTTPS is required outside local development and MUST document the script that generates the development key pair.
Architectural decisions MUST be recorded as ADRs in `docs/adr/` using the standard template (Context / Decision / Consequences).
ADRs are numbered sequentially with a four-digit prefix (`0001-short-title.md`, `0002-...`), are
never renumbered, and are indexed in `docs/adr/README.md`. A superseded ADR is kept and marked as
superseded by the newer one.

## Governance

This constitution supersedes all other project conventions and style guides. When a conflict arises, the constitution takes precedence.

**Amendment procedure**: Any amendment requires (1) a draft PR updating this file, (2) a version bump per the policy below, (3) approval from at least one other maintainer, and (4) a migration note if existing code must change.

**Versioning policy**:
- MAJOR: Removal or redefinition of an existing principle (breaking governance change).
- MINOR: Addition of a new principle or materially expanded guidance.
- PATCH: Clarifications, wording refinements, typo fixes, non-semantic changes.

**Compliance**: Every PR review MUST verify that no constitutional principle is violated. Reviewers are empowered to block merges for violations without exception. New principles take effect immediately upon merge.

**Version**: 1.1.3 | **Ratified**: 2026-11-17 | **Last Amended**: 2026-11-19
