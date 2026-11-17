# ecommerce-identity

Identity microservice of the polyglot e-commerce system (Orders: NestJS, Payments: .NET,
Inventory: Java, Notifications: Python). It owns **users, credentials and sessions** and issues
the **RS256 JWT access tokens** that the other services verify against its JWKS endpoint.

The rules for this repository are in the constitution,
[`.specify/memory/constitution.md`](.specify/memory/constitution.md). The shared event contracts
are in `ecommerce-infra/docs/events.md`, which is the source of truth.

> **Status: in progress.** US-01 (customer registration) is implemented on top of the project
> skeleton, migrations, lazy Kafka producer, health check and Swagger. Everything marked
> **planned** below is set by the constitution but not built yet.

> **HTTPS is required outside local development.** This service receives passwords and issues
> tokens; never expose it over plain HTTP except on `localhost`.

## Roles (planned)

| Role | How it is created | `customerId` |
|---|---|---|
| `CUSTOMER` | Public registration (`POST /auth/register`) | New, generated at registration |
| `ADMIN` | Only by a startup seed from `ADMIN_EMAIL` / `ADMIN_PASSWORD` when no admin exists | None |

No endpoint can change a user's role ([ADR 0003](docs/adr/0003-admin-seed-and-no-role-change.md)).

## Endpoints

| Endpoint | Access | Status |
|---|---|---|
| `GET /health` | public | implemented |
| `GET /docs` (Swagger UI), `GET /docs-json` (OpenAPI) | public | implemented |
| `POST /auth/register` | public, rate limited per IP | implemented |
| `POST /auth/login` | public | planned |
| `POST /auth/refresh` | public (refresh token) | planned |
| `POST /auth/logout` | public (refresh token) | planned |
| `GET /.well-known/jwks.json` | public | planned |
| `GET /users/me` | `CUSTOMER`, `ADMIN` | planned |
| `GET /users` | `ADMIN` | planned |
| `PATCH /users/{id}/status` | `ADMIN` | planned |

`GET /health` returns `200` with `{ "status": "ok", "database": "up", "kafka": "idle" }` when
PostgreSQL answers, and `503` when it does not. The `kafka` field (`idle`, `connected`,
`unavailable`) is informational and never fails the check: the producer connects lazily on the
first publish.

### `POST /auth/register`

Body `{ "email", "name", "password" }` (exactly these strings). Creates an `ACTIVE` `CUSTOMER` with
a new `customerId` and answers `201` with `id`, `customerId`, `email`, `name`, `roles`,
`createdAt`; never a password, hash or token.

- Email is trimmed and lowercased (unique, case-insensitive); name is trimmed, 1–100 characters;
  password is 10–128 characters and must not equal the email. Passwords are hashed with argon2id.
- `400` for invalid input, a missing field or any other property (`roles`, `status`, `id`, …);
  `409` `email already registered`; `429` past `RATE_LIMIT_REGISTER_LIMIT` per client IP.
- **Accepted trade-off:** the `409` tells a caller that an email is registered (account
  enumeration). The per-IP rate limit bounds how fast anyone can probe for that.

## Events

| Topic | Published when | Payload (besides the envelope) |
|---|---|---|
| `identity.user-registered` | A customer registers, after the user is committed (implemented) | `customerId`, `email`, `name` |

Envelope: `eventId`, `aggregateId` (the user id, also the message key), `occurredAt`, `version`.
Orders creates its customer record from this event
([ADR 0004](docs/adr/0004-user-registered-event-choreography.md)). If the publish fails, the
registration still succeeds: the failure is logged and the event is stored in
`outbound_dead_letters` (`PENDING_RETRY`) to be republished with the same `eventId` by the retry
worker (a later story).

## Prerequisites

- Node.js 20+ and npm
- Docker (for the shared infrastructure and for the integration and component tests)
- The [`ecommerce-infra`](../ecommerce-infra) repository, which runs Kafka and one PostgreSQL per
  service. The `postgres-identity` database (`localhost:5435`, database `identity`, user
  `identity_user` / `identity_pass`) must be added there.

## Running locally

```bash
# 1. Start the shared infrastructure (in the ecommerce-infra repo)
docker compose up -d

# 2. In this repo
npm ci
cp .env.example .env
npm run migration:run      # optional: migrations also run at startup (DATABASE_MIGRATIONS_RUN)
npm run start:dev
```

The service listens on `http://localhost:3001` (Swagger UI at `http://localhost:3001/docs`). It
starts even when Kafka is down.

### Docker image

```bash
docker build -t ecommerce-identity .
docker run --rm -p 3001:3001 \
  -e DATABASE_HOST=host.docker.internal \
  ecommerce-identity
```

The image is multi-stage (build, then a slim runtime with production dependencies only), runs as
the non-root `node` user, and has a healthcheck on `GET /health`.

### Keys

The RS256 private key is read from `JWT_PRIVATE_KEY_PATH` and is **never committed**: `keys/` and
`*.pem` are git-ignored. A script that generates a development key pair into `./keys` arrives with
the token story ([ADR 0001](docs/adr/0001-rs256-access-tokens-with-jwks.md)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port (`3000` is Orders, `8080` is Kafka UI) |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated browser origins, matched exactly. Empty: no cross-origin access |
| `DATABASE_HOST` | `localhost` | PostgreSQL host |
| `DATABASE_PORT` | `5435` | PostgreSQL port |
| `DATABASE_NAME` | `identity` | Database name |
| `DATABASE_USER` | `identity_user` | Database user |
| `DATABASE_PASSWORD` | `identity_pass` | Database password (local default only) |
| `DATABASE_MIGRATIONS_RUN` | `true` | Apply pending migrations at startup |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka brokers |
| `KAFKA_CLIENT_ID` | `ecommerce-identity` | Kafka client id |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `1000` | Broker connection timeout; bounds publish latency when Kafka is down |
| `KAFKA_PRODUCER_RETRIES` | `1` | Producer connect/send retries before giving up |
| `ARGON2_MEMORY_COST_KIB` | `65536` | argon2id memory cost (KiB) for password hashes |
| `ARGON2_TIME_COST` | `3` | argon2id iterations |
| `ARGON2_PARALLELISM` | `4` | argon2id parallelism |
| `RATE_LIMIT_REGISTER_LIMIT` | `5` | `POST /auth/register` requests allowed per client IP per window |
| `RATE_LIMIT_REGISTER_TTL_MS` | `60000` | Length of that window, in ms |
| `JWT_ISSUER` | unset | `iss` claim of access tokens (later story) |
| `JWT_AUDIENCE` | unset | `aud` claim of access tokens (later story) |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime (later story) |
| `JWT_PRIVATE_KEY_PATH` | unset | Path of the RS256 private key PEM (later story) |

## Quality gate

After every task and before every commit, run in this order; all four must pass:

```bash
npm run build
npm run lint           # --max-warnings 0: warnings are blocking
npm run format:check
npm run test           # unit + integration + component (needs Docker)
```

Narrower runs: `npm run test:unit`, `npm run test:integration`, `npm run test:component`;
coverage with `npm run test:cov` (80% minimum on domain and services).

The integration and component tests start PostgreSQL (and, where an event is asserted, Kafka)
with testcontainers. They never use the shared `localhost:9092` broker, so they pass whether or not
the local infrastructure is running.

## Project layout

```text
src/
  config/          configuration read from environment variables
  commands/        CQRS commands (RegisterCustomerCommand)
  controllers/     HTTP I/O only (routing, DTO validation, response shaping)
  services/        orchestration (command handlers); no business rules
    ports/         abstractions services depend on (PasswordHasher, UserEventPublisher)
  domain/          aggregates (User, RefreshToken), value objects, domain events — all business rules
  repositories/    persistence behind domain-facing interfaces
  dto/             request/response DTOs (class-validator, Swagger)
  infra/
    database/      TypeORM options, CLI data source, migrations
    kafka/         Kafka module, lazily connecting producer, UserEventsProducer
    security/      Argon2PasswordHasher (argon2id)
  app.module.ts, app.setup.ts (CORS, ValidationPipe), app.swagger.ts, main.ts
tests/
  unit/            no NestJS DI, no database, no Kafka
  integration/     real PostgreSQL via testcontainers
  component/       whole app against real PostgreSQL
docs/adr/          architecture decision records
```

## Documentation

- Constitution: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)
- Architecture decisions: [`docs/adr/`](docs/adr/README.md)
- Event contracts: `ecommerce-infra/docs/events.md`
