# ecommerce-identity

Identity microservice of the polyglot e-commerce system (Orders: NestJS, Payments: .NET,
Inventory: Java, Notifications: Python). It owns **users, credentials and sessions** and issues
the **RS256 JWT access tokens** that the other services verify against its JWKS endpoint.

The rules for this repository are in the constitution,
[`.specify/memory/constitution.md`](.specify/memory/constitution.md). The shared event contracts
are in `ecommerce-infra/docs/events.md`, which is the source of truth.

> **Status: in progress.** US-01 to US-05 are implemented: customer registration, login, the JWKS
> endpoint with key rotation, refresh and logout, and `GET /users/me` with default-deny role guards.
> Everything marked **planned** below is set by the constitution but not built yet.

> **HTTPS is required outside local development.** This service receives passwords and issues
> tokens; never expose it over plain HTTP except on `localhost`.

## Roles

| Role | How it is created | `customerId` |
|---|---|---|
| `CUSTOMER` | Public registration (`POST /auth/register`) | New, generated at registration |
| `ADMIN` | Only by a startup seed from `ADMIN_EMAIL` / `ADMIN_PASSWORD` when no admin exists (the seed is planned) | None |

No endpoint can change a user's role ([ADR 0003](docs/adr/0003-admin-seed-and-no-role-change.md)).

## Endpoints

| Endpoint | Access | Status |
|---|---|---|
| `GET /health` | public | implemented |
| `GET /docs` (Swagger UI), `GET /docs-json` (OpenAPI) | public | implemented |
| `POST /auth/register` | public, rate limited per IP | implemented |
| `POST /auth/login` | public, rate limited per IP and per email | implemented |
| `POST /auth/refresh` | public (refresh token), rate limited per IP | implemented |
| `POST /auth/logout` | public (refresh token), rate limited per IP | implemented |
| `GET` / `HEAD /.well-known/jwks.json` | public, not rate limited | implemented |
| `GET /users/me` | `CUSTOMER`, `ADMIN` | implemented |
| `GET /users` | `ADMIN` | planned |
| `PATCH /users/{id}/status` | `ADMIN` | planned |

`GET /users/me` returns the caller's account as stored now:
`{ "id", "customerId", "email", "name", "roles", "status", "createdAt" }`. `customerId` is left out
entirely for admins; no password, hash or token is ever returned. A user deleted or disabled after
login gets the same `401` as an invalid token. It reads PostgreSQL only and works with Kafka down.

`GET /health` returns `200` with `{ "status": "ok", "database": "up", "kafka": "idle" }` when
PostgreSQL answers, and `503` when it does not. The `kafka` field (`idle`, `connected`,
`unavailable`) is informational and never fails the check: the producer connects lazily on the
first publish.

`GET /.well-known/jwks.json` returns the public keys that verify access tokens, as
`{ "keys": [{ "kty": "RSA", "use": "sig", "alg": "RS256", "kid", "n", "e" }] }`: the active
signing key first, then the retired keys still accepted, in configured order. It needs no
authentication (any `Authorization` header is ignored), is not rate limited, and touches neither
PostgreSQL nor Kafka. Responses carry `Cache-Control: public, max-age=<JWKS_CACHE_SECONDS>` and a
strong `ETag`; a request whose `If-None-Match` matches (exact, `W/` form, in a list, or `*`) gets
`304` with the same headers and no body.

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

### `POST /auth/login`

Body `{ "email", "password" }` (exactly these strings). For an `ACTIVE` user with the right
password it answers `200` with `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn }`.

- The email is normalized as at registration; the password is used exactly as sent (no password
  policy at login).
- Every failure (unknown email, wrong password, user not `ACTIVE`) answers the same `401`
  `{ "statusCode": 401, "message": "invalid credentials", "error": "Unauthorized" }`, after exactly
  one argon2id verification (against a dummy hash for an unknown email), so neither the body nor
  the timing reveals whether an account exists.
- `400` for a missing, empty or non-string field, any other property, malformed JSON or a badly
  formed email; `429` past `RATE_LIMIT_LOGIN_LIMIT` per client IP **or** per normalized email
  within `RATE_LIMIT_LOGIN_TTL_MS` (every request counts, including `400`s); `5xx` if the database
  is down (never `401`).
- The refresh token is opaque (256 random bits, 43 base64url characters), valid for
  `JWT_REFRESH_TTL_SECONDS`, and shown only in this response: the database stores its SHA-256 hash
  in `refresh_tokens`, together with `users.lastLoginAt`, in one transaction.

### `POST /auth/refresh`

Body `{ "refreshToken" }` (exactly this non-empty string, at most 512 characters). Exchanges a
valid refresh token for a new pair and answers `200` with the login shape
`{ accessToken, refreshToken, tokenType: "Bearer", expiresIn }`.

- The token is looked up by its SHA-256 hash. In one transaction, under a per-family lock, it is
  marked used (`revokedAt`, `replacedBy`) and a new hashed token is stored in the same family.
  Of two concurrent refreshes with the same token, exactly one succeeds.
- The access token is built from the user's **current** `roles`, `customerId` and `status`.
- The new refresh token expires at the earlier of now + `JWT_REFRESH_TTL_SECONDS` and the session
  limit: the family's login time + `JWT_SESSION_MAX_SECONDS` (default 30 days). After that, the
  user must log in again.
- Every token or account failure (unknown, expired, already used or revoked, user not `ACTIVE`,
  session limit reached) answers the same `401`
  `{ "message": "invalid refresh token", "error": "Unauthorized", "statusCode": 401 }`.
  Presenting a used or revoked token is treated as theft: **the whole family is revoked**, including
  the token the legitimate refresh issued. A user who is no longer `ACTIVE` also has the family
  revoked.
- `400` for an invalid body; `429` past `RATE_LIMIT_REFRESH_LIMIT` per client IP within
  `RATE_LIMIT_REFRESH_TTL_MS`; `5xx` if the database is down (never `401`).

### `POST /auth/logout`

Body `{ "refreshToken" }` (same validation). Answers `204` with no body for every well-formed
request, whatever the token's state, so the response reveals nothing about it. For a known token
it revokes every token of its family. `400` for an invalid body; `429` past
`RATE_LIMIT_LOGOUT_LIMIT` per client IP within `RATE_LIMIT_LOGOUT_TTL_MS`; `5xx` if the database is
down (never `204`).

### Session trade-offs

- **Access tokens outlive logout.** Access tokens are stateless JWTs: one issued before a logout
  (or a reuse revocation, or disabling the user) stays valid until its `exp`, at most
  `JWT_ACCESS_TTL_SECONDS` (15 minutes by default).
- **Reuse detection is strict, with no grace window.** A client that retries a refresh after
  losing the first response presents a used token, so the session is revoked and the user must log
  in again. Clients must not retry a refresh blindly.
- **Expired and revoked refresh tokens are not purged yet.** They stay in `refresh_tokens`; a purge
  job is future work.

### Access token

RS256 JWT with header `{ "alg": "RS256", "kid", "typ": "JWT" }`, where `kid` is the RFC 7638
SHA-256 thumbprint of the public key. Claims, exactly:

| Claim | Value |
|---|---|
| `sub` | User id |
| `customerId` | Customer id; absent for users without one (admins) |
| `roles` | Current roles, e.g. `["CUSTOMER"]` |
| `iss` / `aud` | `JWT_ISSUER` / `JWT_AUDIENCE` |
| `iat` / `exp` | Issue time; `iat + JWT_ACCESS_TTL_SECONDS` |
| `jti` | Unique id (UUID) |

### Verifying access tokens (downstream services)

Implemented and tested by `tests/support/reference-verifier.ts`
([contract](specs/003-jwks-key-rotation/contracts/verification-contract.md)):

1. Fetch `GET /.well-known/jwks.json` and cache it (honour `Cache-Control`, revalidate with `ETag`).
2. Accept **RS256 only**; reject `none`, `HS*` and anything else.
3. Require a `kid` in the header and use the published key with that `kid`; never try every key.
4. Check the signature, then `iss` = `JWT_ISSUER`, `aud` contains `JWT_AUDIENCE`, `exp` in the future.
5. Unknown `kid`: refetch the key set **at most once per minute** (counted from the previous
   refetch; the initial load does not count). Still unknown: reject.
6. Take `sub`, `customerId` and `roles` only from the verified token.

## Access control

Every route is **denied by default**. A route is reachable only when it declares exactly one policy:

- `@Public()`: no token is read; any `Authorization` header is ignored (register, login, refresh,
  logout, JWKS, health). `/docs` and `/docs-json` are served outside Nest routing and stay public.
- `@Roles(...)`: the caller must send a valid access token and hold one of the listed roles.

A route with neither, both, or an empty `@Roles()` **stops the service at startup** with
`route policy violation: <Controller>.<handler> (<METHOD> <path>), …`. `@Roles` also documents the
bearer scheme, the roles (`x-roles`), 401 and 403 in Swagger.

Call a protected route with the access token from login or refresh:

```bash
curl -H "Authorization: Bearer <accessToken>" http://localhost:3001/users/me
```

The service verifies its own tokens locally (no network call): RS256 only, `kid` from the published
key set (active or retired), signature, `iss`, `aud`, `exp`/`iat`/`nbf` with
`JWT_CLOCK_TOLERANCE_SECONDS` of skew, and the `sub`, `iat`, `exp`, `jti` and `roles` claims.

| Outcome | Status | Body |
|---|---|---|
| Missing, malformed, untrusted or expired token, or the user is no longer active | `401` + `WWW-Authenticate: Bearer` | `{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}`, byte-identical for every cause |
| Valid token, but none of the route's roles | `403` | `{"statusCode":403,"message":"forbidden","error":"Forbidden"}` |

The failure reason is logged at `warn`; tokens and `Authorization` values never are. Access tokens
are not revoked by logout: they stay valid until they expire (15 minutes by default). See
[ADR 0005](docs/adr/0005-default-deny-route-guards.md).

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
npm run keys:generate      # writes keys/private.pem and keys/public.pem (git-ignored)
npm run migration:run      # optional: migrations also run at startup (DATABASE_MIGRATIONS_RUN)
npm run start:dev
```

The service listens on `http://localhost:3001` (Swagger UI at `http://localhost:3001/docs`). It
starts even when Kafka is down, but **refuses to start** without a valid signing key and
`JWT_ISSUER` / `JWT_AUDIENCE`.

### Docker image

```bash
docker build -t ecommerce-identity .
docker run --rm -p 3001:3001 \
  -e DATABASE_HOST=host.docker.internal \
  -e JWT_ISSUER=http://localhost:3001 -e JWT_AUDIENCE=ecommerce \
  -e JWT_PRIVATE_KEY_PATH=/run/keys/private.pem \
  -v "$(pwd)/keys:/run/keys:ro" \
  ecommerce-identity
```

The image is multi-stage (build, then a slim runtime with production dependencies only), runs as
the non-root `node` user, and has a healthcheck on `GET /health`.

### Keys

The RS256 private key is read from `JWT_PRIVATE_KEY_PATH` and is **never committed**: `keys/` and
`*.pem` are git-ignored ([ADR 0001](docs/adr/0001-rs256-access-tokens-with-jwks.md)).

- `npm run keys:generate` writes a 2048-bit RSA pair to `./keys` (`private.pem` PKCS#8 with mode
  0600, `public.pem`) and prints the paths and the `kid`, never the key.
  `npm run keys:generate -- --name next` writes `keys/next-private.pem` and `keys/next-public.pem`
  instead (`--name` matches `^[A-Za-z0-9_-]+$`). An existing pair is never overwritten unless
  `--force` is passed; unknown flags and bad names fail and write nothing.
- `JWT_RETIRED_PUBLIC_KEY_PATHS` lists public key files (SPKI `PUBLIC KEY` or PKCS#1
  `RSA PUBLIC KEY`, one PEM block each) that are published for verification but never sign.
- At startup the key must exist and be an RSA private key (PKCS#8 or PKCS#1) of at least 2048
  bits; otherwise the service exits with an error that names the problem and never contains key
  content.
- Each retired file must hold exactly one RSA public key of at least 2048 bits. A private key,
  several blocks, a certificate, a missing file, or a key that duplicates another (same `kid`)
  stops startup with an error naming the file(s).
- The `kid` is derived from the key, so it stays the same across restarts.

### Rotating the signing key

1. `npm run keys:generate -- --name next` creates the new pair.
2. Point `JWT_PRIVATE_KEY_PATH` at `keys/next-private.pem`.
3. Add the previous public key (e.g. `keys/public.pem`) to `JWT_RETIRED_PUBLIC_KEY_PATHS`.
4. Restart. New tokens carry the new `kid`; tokens signed by the previous key still verify.
5. After the access token lifetime (`JWT_ACCESS_TTL_SECONDS`) plus the JWKS cache time
   (`JWKS_CACHE_SECONDS`), remove the previous key from `JWT_RETIRED_PUBLIC_KEY_PATHS` and restart.

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
| `RATE_LIMIT_LOGIN_LIMIT` | `10` | `POST /auth/login` requests allowed per client IP, and per normalized email, per window |
| `RATE_LIMIT_LOGIN_TTL_MS` | `60000` | Length of that window, in ms |
| `RATE_LIMIT_REFRESH_LIMIT` | `30` | `POST /auth/refresh` requests allowed per client IP per window |
| `RATE_LIMIT_REFRESH_TTL_MS` | `60000` | Length of that window, in ms |
| `RATE_LIMIT_LOGOUT_LIMIT` | `30` | `POST /auth/logout` requests allowed per client IP per window |
| `RATE_LIMIT_LOGOUT_TTL_MS` | `60000` | Length of that window, in ms |
| `JWT_ISSUER` | unset, **required** | `iss` claim of access tokens |
| `JWT_AUDIENCE` | unset, **required** | `aud` claim of access tokens |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime, in seconds |
| `JWT_REFRESH_TTL_SECONDS` | `604800` | Refresh token lifetime, in seconds (7 days) |
| `JWT_SESSION_MAX_SECONDS` | `2592000` | Absolute session lifetime from login, in seconds (30 days); must be at least `JWT_REFRESH_TTL_SECONDS`, otherwise startup fails |
| `JWT_CLOCK_TOLERANCE_SECONDS` | `5` | Clock skew, in seconds, allowed when verifying `exp`, `iat` and `nbf` on protected routes; a non-negative integer, otherwise startup fails |
| `JWT_PRIVATE_KEY_PATH` | unset, **required** | Path of the RS256 private key PEM (e.g. `./keys/private.pem`) |
| `JWT_RETIRED_PUBLIC_KEY_PATHS` | empty | Comma-separated retired public key PEM paths, published after the active key, in order |
| `JWKS_CACHE_SECONDS` | `300` | `max-age` of the key set; a non-negative integer, otherwise startup fails |

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
