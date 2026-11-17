# CLAUDE.md

Identity microservice: NestJS + TypeScript, DDD. Owns users, credentials and sessions and issues
the RS256 JWTs other services verify. The source of truth for every rule below is
`.specify/memory/constitution.md`. If this file and the constitution disagree, the constitution
wins.

## Stack

- NestJS 10, TypeScript (strict, `any` banned), Node.js 20+
- REST + Swagger (`/docs`), TypeORM + PostgreSQL (migrations only, `synchronize` off)
- `jose` (RS256 + JWKS), `argon2` (argon2id), `@nestjs/throttler`
- Kafka via `kafkajs` — producer only (`identity.user-registered`)
- Jest, Supertest, `@nestjs/testing`, testcontainers
- Local infra from the `ecommerce-infra` repo (`docker compose up -d` there): Kafka
  `localhost:9092`, Postgres `localhost:5435` (`identity` / `identity_user` / `identity_pass`)
- HTTP port `PORT`, default `3001`
- Startup never waits for Kafka. The producer connects lazily on the first publish
  (`src/infra/kafka/lazy-kafka-producer.ts`). Don't add awaited `connect()` calls to module
  factories or lifecycle hooks. `GET /health` reports Kafka but only the database can fail it.

## Commands

```bash
npm run build
npm run lint
npm run format:check
npm run test              # also: test:unit, test:integration, test:component (needs Docker)
npm run migration:run
npm run start:dev
```

## Quality gate (after every task, before every commit)

Run `npm run build`, `npm run lint`, `npm run format:check` and `npm run test`, in that order. All
four must pass. Fix any failure before moving on. Never commit a failing build, a lint error or
warning (`--max-warnings 0`), or a formatting violation. Never mark a task complete with a red gate.

## Layering

**Controller → Service → Domain → Repository.**

- Controllers: HTTP I/O and DTO validation only. Map domain errors to NestJS exceptions here.
- Services: orchestrate only (domain → repository → Kafka).
- Domain (`src/domain/`): **all** business logic. No I/O, no NestJS, no TypeORM.
- Repositories: persistence only. TypeORM entities are separate from domain objects and mapped
  explicitly.
- Aggregates: `User`, `RefreshToken`. Roles and statuses are enums (`Role`, `UserStatus`).

## Security (non-negotiable)

- argon2id for passwords; never log, return or store a password in clear.
- One generic login error for every failure; constant-time comparison (dummy hash for unknown
  emails).
- Access tokens: RS256, 15 min default, claims `sub`, `customerId` (customers only), `roles`,
  `iss`, `aud`, `iat`, `exp`, `jti`, header `kid`. JWKS supports several active keys.
- Private keys never committed (`keys/`, `*.pem` are git-ignored).
- Refresh tokens: opaque, ≥256 bits, stored hashed, single use, rotated; reuse revokes the family.
- Rate limit register and login. Never log tokens, passwords or `Authorization` headers.
- CORS only from `CORS_ALLOWED_ORIGINS`. Every non-public endpoint declares its roles.
- No endpoint changes a role; admins come only from the startup seed.

## Write flow

Validate → domain → **PostgreSQL commit first → then publish** `identity.user-registered`. A failed
publish is logged, written to the outbound dead-letter table and retried by the worker (`FOR UPDATE
SKIP LOCKED`, exponential backoff, same `eventId`, `RESOLVED` / `EXHAUSTED`); the client still
gets success.

## Out of scope (unless the constitution is amended)

Email verification, password reset, social login, MFA, profile editing, role changes via the API.

## Branches and commits

- Branches from `main`: `feature/US-XX-short-description`, `fix/US-XX-short-description`,
  `chore/short-description`. One user story per branch. Never commit directly to `main`.
- Before `/speckit.specify`: clean tree → `git checkout main && git pull` →
  `git checkout -b feature/US-XX-...`. Never write spec files while on `main`.
- Conventional Commits with the story scope: `feat(US-01): ...`, `test(US-01): ...`,
  `docs(US-01): ...`; `chore:` / `build:` / `docs:` for non-story work.
- PRs reference the story ("Implements US-01: Register a user"); branches are deleted after merge.

## Documentation

- JSDoc on all public classes, methods and interfaces; Swagger on every endpoint and DTO.
- Event payloads documented in the event class JSDoc **and** `ecommerce-infra/docs/events.md`
  (same change).
- ADRs in `docs/adr/`, numbered `NNNN-`, never renumbered, indexed in `docs/adr/README.md`.
