# ecommerce-identity

Identity microservice of the polyglot e-commerce system (Orders: NestJS, Payments: .NET,
Inventory: Java, Notifications: Python). It owns **users, credentials and sessions** and issues
the **RS256 JWT access tokens** that the other services verify against its JWKS endpoint.

The rules for this repository are in the constitution,
[`.specify/memory/constitution.md`](.specify/memory/constitution.md). The shared event contracts
are in `ecommerce-infra/docs/events.md`, which is the source of truth.

> **Status: complete.** US-01 to US-12 are implemented: customer registration, login, the JWKS
> endpoint with key rotation, refresh and logout, `GET /users/me` with default-deny role guards, the
> startup admin seed, the admin `GET /users` and `GET /users/{id}`, enabling or disabling users
> with `PATCH /users/{id}/status`, the outbound retry worker (US-08), admin user creation with
> `POST /users` (US-09), role changes with `PUT /users/{id}/roles` (US-10), the audit trail
> `GET /audit` (US-11) and changing one's own password with `POST /users/me/password` (US-12).

> **HTTPS is required outside local development.** This service receives passwords and issues
> tokens; never expose it over plain HTTP except on `localhost`.

## Roles

| Role | How it is created | `customerId` |
|---|---|---|
| `CUSTOMER` | Public registration (`POST /auth/register`), or an `ADMIN` through `POST /users` | New, generated at creation |
| `ADMIN` | The startup seed from `ADMIN_EMAIL` / `ADMIN_PASSWORD` when no admin exists ([Admin seed](#admin-seed)), or an `ADMIN` through `POST /users` | None |

Users are created with one role and may later hold both. Roles change only through
`PUT /users/{id}/roles`, called by an `ADMIN`; never self-service. A user cannot remove their own `ADMIN` role, and the last `ACTIVE` admin can never
lose `ADMIN` or be disabled. Every user creation by an admin, role change and status change is
recorded in an append-only audit trail readable by admins through [`GET /audit`](#get-audit)
([ADR 0008](docs/adr/0008-admin-creation-and-role-changes-through-the-api.md), which supersedes
[ADR 0003](docs/adr/0003-admin-seed-and-no-role-change.md)).

> **Admin-created users.** A user created through `POST /users` gets the password the admin
> supplies, so the admin knows it. That user should change it with `POST /users/me/password`
> right after the first login.

## Endpoints

| Method | Path | Allowed roles | Rate limit (defaults) |
|---|---|---|---|
| `GET` | `/health` | public | none |
| `GET` | `/docs` (Swagger UI), `/docs-json` (OpenAPI) | public | none |
| `GET`, `HEAD` | `/.well-known/jwks.json` | public | none |
| `POST` | `/auth/register` | public | 5 per minute per client IP (`RATE_LIMIT_REGISTER_*`) |
| `POST` | `/auth/login` | public | 10 per minute per client IP **and** per normalized email (`RATE_LIMIT_LOGIN_*`) |
| `POST` | `/auth/refresh` | public (refresh token in the body) | 30 per minute per client IP (`RATE_LIMIT_REFRESH_*`) |
| `POST` | `/auth/logout` | public (refresh token in the body) | 30 per minute per client IP (`RATE_LIMIT_LOGOUT_*`) |
| `GET` | `/users/me` | `CUSTOMER`, `ADMIN` | none |
| `POST` | `/users/me/password` | `CUSTOMER`, `ADMIN` | 5 per minute per user id and client IP (`RATE_LIMIT_PASSWORD_CHANGE_*`) |
| `GET` | `/users` | `ADMIN` | none |
| `GET` | `/users/{id}` | `ADMIN` | none |
| `POST` | `/users` | `ADMIN` | none |
| `PATCH` | `/users/{id}/status` | `ADMIN` | none |
| `PUT` | `/users/{id}/roles` | `ADMIN` | none |
| `GET` | `/audit` | `ADMIN` | none |

Past its limit a rate-limited route answers `429`; every request counts, including rejected ones.
Protected routes answer `401` without a valid token and `403` without one of the listed roles. In
Swagger, each operation states its access at the top of its description (`x-public` or `x-roles`)
and lists its error responses.

`GET /users/me` returns the caller's account as stored now:
`{ "id", "customerId", "email", "name", "roles", "status", "createdAt" }`. `customerId` is left out
entirely for a user who never held `CUSTOMER`; no password, hash or token is ever returned. A user deleted or disabled after
login gets the same `401` as an invalid token. It reads PostgreSQL only and works with Kafka down.

`GET /users` lists users for admins, newest first (`createdAt` descending, then `id`), as
`{ "items", "total", "limit", "offset" }`. Query parameters, all optional and combined with AND:

| Parameter | Default | Rule |
|---|---|---|
| `limit` | `20` | Integer, 1–100 |
| `offset` | `0` | Integer, ≥ 0 |
| `role` | none | `CUSTOMER` or `ADMIN` |
| `status` | none | `ACTIVE` or `DISABLED` |
| `email` | none | Case-insensitive email prefix, matched literally (`%` and `_` are not wildcards), at most 254 characters; empty is ignored |

Each item is `{ "id", "customerId", "email", "name", "roles", "status", "createdAt", "lastLoginAt" }`:
`customerId` is left out for a user who never held `CUSTOMER` and `lastLoginAt` is `null` until the first login. No password
or hash is ever returned. `total` counts every matching user; an offset past the end returns no
items with the real total. An invalid or unknown parameter gets `400` with the validation messages.

`GET /users/{id}` returns one user in the same shape: `404` (`user not found`) when no user has
this id, `400` when the id is not a UUID. `GET /users/me` keeps its own handler. Both endpoints read
PostgreSQL only and work with Kafka down.

### `PATCH /users/{id}/status`

Admins only. Body `{ "status": "ACTIVE" | "DISABLED" }` (exact case, no other field). Answers `200`
with the user after the request, in the `GET /users/{id}` shape.

- `DISABLED` sets the status and revokes **every** refresh token of the user (all sessions) in one
  transaction. Login, refresh and `GET /users/me` then refuse the user with their usual generic
  `401`.
- `ACTIVE` restores login. Tokens revoked by the disable stay revoked: the user logs in again.
- Setting the status a user already has is a no-op: `200`, nothing written, nothing logged.
- Safeguards: an admin cannot disable their own account (`409`
  `an admin cannot disable their own account`), and the last `ACTIVE` admin cannot be disabled
  (`409` `the last active admin cannot be disabled`). The acting admin is re-read in the same
  transaction: an admin disabled since their token was issued gets the generic `401`. Status
  changes are serialized, so two admins disabling each other at once leave exactly one `ACTIVE`
  admin (the other request gets `401`).
- `400` for a malformed id, a missing, unknown or wrongly cased status, an extra field or malformed
  JSON; `404` (`user not found`) for an unknown id; `401` / `403` as for every protected route.
- Every effective change logs
  `user status changed: actorId=… targetId=… from=… to=… revokedTokens=N` (ids only) and writes a
  `USER_STATUS_CHANGED` audit record (actor, target, `before`/`after` status) in the same
  transaction; a no-op writes neither. No role is ever changed, no event is published, and the
  endpoint works with Kafka down.

### `PUT /users/{id}/roles`

Admins only. Body `{ "roles": [...] }`: a non-empty list of distinct values from `CUSTOMER` and
`ADMIN`, any order, no other field. The list **replaces** the user's roles. Answers `200` with the
user after the request, in the `GET /users/{id}` shape.

- Removing any role revokes **every** refresh token of the user in the same transaction; a
  grant-only change revokes none.
- The first `CUSTOMER` grant to a user without `customerId` creates one and publishes
  `identity.user-registered` after the commit (dead-lettered and retried if Kafka is down; still
  `200`). Removing `CUSTOMER` keeps the `customerId` (shown to admins, never put in a token); a
  later grant reuses it without a new event. `ADMIN` never touches it.
- Sending the current roles is a no-op: `200`, nothing written, revoked, published or logged.
- Safeguards (`409`): an admin cannot remove their own `ADMIN` role
  (`an admin cannot remove their own ADMIN role`), and the last `ACTIVE` admin cannot lose it
  (`the last active admin cannot lose the ADMIN role`). Role and status changes share one lock, so
  concurrent demotions and disables always leave an `ACTIVE` admin; an admin demoted or disabled
  since their token was issued gets the generic `401`.
- `400` for a malformed id or an invalid body; `404` (`user not found`) for an unknown id; `401` /
  `403` as for every protected route.
- Every effective change logs `user roles changed: actorId=… targetId=… before=… after=…
  revokedTokens=N` (ids and roles only) and writes a `ROLES_CHANGED` audit record (actor, target,
  `before`/`after` roles) in the same transaction
  ([ADR 0010](docs/adr/0010-role-changes-keep-customer-id-and-share-the-admin-lock.md)).

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

### `POST /users`

Admins only. Creates an `ACTIVE` user with **exactly one** role:

```json
{ "email": "bea@example.com", "name": "Bea", "password": "bea-initial-pass-123", "roles": ["ADMIN"] }
```

- Email, name and password follow the registration rules (trimmed, lowercased email; 10–128
  character password, not equal to the email). `roles` is `["CUSTOMER"]` or `["ADMIN"]`; an
  empty list, an unknown or repeated role, or both roles return `400`. Any other field (`id`,
  `customerId`, `status`, …) returns `400`.
- `201` with the user in the `GET /users/{id}` shape (no password, no hash). A customer gets a new
  `customerId` and `identity.user-registered` is published after the commit, exactly as for
  registration (dead-lettered and retried when Kafka is down). An admin gets no `customerId` and no
  event.
- `409` when the email is already used (whatever the case or the user's status). `401` without a
  token, or when the caller is no longer an `ACTIVE` admin (their token may still be valid);
  `403` for a customer.
- The user and an audit record (`USER_CREATED`: actor id, new user id, roles, time) are written
  in one transaction ([ADR 0009](docs/adr/0009-append-only-audit-table.md)); one log line
  `user created: actorId=… targetId=… roles=…` follows. Nothing secret is logged or audited.
- **Trade-off:** the admin chooses the initial password and therefore knows it. The user should
  change it with `POST /users/me/password` right after the first login.

### `GET /audit`

Admins only. One page of the audit trail, newest first (`createdAt` desc, then `id` desc):
`{ "items", "total", "limit", "offset" }`; each item is exactly
`{ "id", "actorId", "action", "targetId", "before", "after", "createdAt" }`.

- Audited actions: `USER_CREATED` (`POST /users`, `after` = roles), `ROLES_CHANGED`
  (`PUT /users/{id}/roles`, roles before/after) and `USER_STATUS_CHANGED`
  (`PATCH /users/{id}/status`, status before/after). Each is written in the same transaction as
  the change; no-ops and failed changes write nothing; the startup seed writes nothing.
- Records never hold passwords, hashes, tokens or emails.
- Query: `limit` 1–100 (default 20), `offset` ≥ 0 (default 0), optional `actorId`, `targetId`
  (UUIDs) and `action`, combined with AND. `total` counts every match; an offset past the end
  returns no items with the real total.
- `400` for an invalid, repeated or unknown parameter; `401` without a token or when the caller is
  no longer an `ACTIVE` admin; `403` for a customer. Reads are neither audited nor logged.
- **Append-only:** the `audit_records_append_only` trigger rejects every `UPDATE` and `DELETE`
  whatever database role the app connects as
  ([ADR 0009](docs/adr/0009-append-only-audit-table.md)). Indexes on `occurredAt`, `actorId` and
  `targetId` back the ordering and filters.

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

### Change my password

`POST /users/me/password` (`CUSTOMER`, `ADMIN`) with `{"currentPassword": "...", "newPassword":
"..."}` returns `200` with a new token pair in the login shape, so the caller stays signed in. In one
transaction it stores the new argon2id hash, revokes **every** refresh token of the user (every
session, the calling one included) and stores the new refresh token (new family). No event is
published; it works with Kafka down.

| Case | Response |
|------|----------|
| Missing/empty/non-string field, unknown property, invalid JSON | `400` |
| Wrong current password (checked first) | `401 invalid credentials` |
| New password: under 10 or over 128 characters, the email (any case), or the current one | `400` |
| No or invalid token, user disabled or deleted | `401 unauthorized` (generic) |
| More than `RATE_LIMIT_PASSWORD_CHANGE_LIMIT` attempts per user and IP in the window | `429` |

The success is logged with the user id only; passwords, hashes and tokens are never logged.

### Session trade-offs

- **Access tokens outlive logout.** Access tokens are stateless JWTs: one issued before a logout
  (or a reuse revocation, or disabling the user) stays valid until its `exp`, at most
  `JWT_ACCESS_TTL_SECONDS` (15 minutes by default).
- **Disabling a user is immediate where the database is read, not everywhere.** A disabled user's
  access tokens stay valid on token-only routes (and in downstream services) until `exp`, at most
  `JWT_ACCESS_TTL_SECONDS`. `GET /users/me`, login, refresh and `PATCH /users/{id}/status` read the
  current status and refuse the user at once; every refresh token is already revoked
  ([ADR 0006](docs/adr/0006-status-changes-serialized-and-sessions-revoked.md)).
- **A password change ends other sessions at their next refresh, not at once.** Access tokens
  issued before the change stay valid until `exp`, at most `JWT_ACCESS_TTL_SECONDS`; every refresh
  token issued before it is refused.
- **Role changes reach access tokens only at refresh or login.** A token issued before a role
  change keeps its old roles until `exp`, at most `JWT_ACCESS_TTL_SECONDS`. Removing a role
  revokes every refresh token, so the user must log in again to get the reduced roles.
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

## Admin seed

The seed creates the **first** administrator; later admins are created by an admin through
`POST /users`. At startup, after migrations and before the server accepts requests, the
service creates the first administrator from three variables:

| Variable | Rule |
|---|---|
| `ADMIN_EMAIL` | Same validation and normalization as registration (trimmed, lowercase) |
| `ADMIN_PASSWORD` | Same policy as registration: 10–128 characters, different from the email. Stored only as an argon2id hash and never logged |
| `ADMIN_NAME` | Optional, default `Administrator`; same rule as a registration name |

| Situation | What happens |
|---|---|
| An admin already exists (any status) | Nothing; no log line |
| No admin, and `ADMIN_EMAIL` or `ADMIN_PASSWORD` unset or empty | Nothing; a `warn` line; the service starts |
| No admin, and a value breaks a rule | Nothing; an `error` line `ADMIN_<VAR>: <rule>` (never the value); the service starts |
| No admin, and `ADMIN_EMAIL` belongs to a customer | Nothing; that user is never changed or promoted; an `error` line; the service starts |
| No admin, valid values, free email | One `ADMIN` is created: `ACTIVE`, no `customerId`; the log shows its id only |
| Another instance seeded it at the same moment | Nothing; a `warn` line |
| Database unavailable | Startup fails, as for any database error |

The seed publishes no event: `identity.user-registered` is for customers only. Restarts never change
an existing admin, so changing `ADMIN_PASSWORD` later has no effect. **Remove `ADMIN_PASSWORD` from
the environment after the first start**: it is only needed once, and leaving a plain-text admin
password in the deployment configuration is a needless risk.

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
| Missing, malformed, untrusted or expired token, or the user is no longer active (checked by `GET /users/me` and `PATCH /users/{id}/status`) | `401` + `WWW-Authenticate: Bearer` | `{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}`, byte-identical for every cause |
| Valid token, but none of the route's roles | `403` | `{"statusCode":403,"message":"forbidden","error":"Forbidden"}` |

The failure reason is logged at `warn`; tokens and `Authorization` values never are. Access tokens
are not revoked by logout: they stay valid until they expire (15 minutes by default). See
[ADR 0005](docs/adr/0005-default-deny-route-guards.md).

## Security notes

- **Passwords: argon2id.** Passwords are hashed with argon2id (`ARGON2_*`: 64 MiB, 3 iterations
  and parallelism 4 by default). A password is never logged, returned, audited or stored in clear.
  The same policy (10–128 characters, not the email) applies to registration, the admin seed,
  `POST /users` and password changes.
- **Tokens: RS256 and JWKS.** Access tokens are RS256 JWTs (15 minutes by default) with a `kid`
  header. Downstream services verify them locally against `GET /.well-known/jwks.json`, which can
  publish several keys during a rotation. Only RS256 is accepted: `none` and `HS*` are rejected.
  Private keys are never committed ([ADR 0001](docs/adr/0001-rs256-access-tokens-with-jwks.md)).
- **Refresh rotation and reuse detection.** Refresh tokens are opaque (256 random bits), stored
  only as SHA-256 hashes, single use and rotated on every refresh. Presenting a used or revoked
  token revokes its whole family. Sessions also end after `JWT_SESSION_MAX_SECONDS`
  ([ADR 0002](docs/adr/0002-refresh-token-rotation-with-reuse-detection.md)).
- **Generic login errors.** Every login failure answers the same `401 invalid credentials` after
  exactly one argon2id verification (against a dummy hash for an unknown email), so neither the
  body nor the timing reveals whether an account exists. Refresh and the protected routes each have
  a single generic `401`. Register and login are rate limited.
- **Default deny.** Every route needs exactly one of `@Public()` or a non-empty `@Roles(...)`;
  otherwise the service refuses to start. Roles come only from the verified token, and admin
  mutations re-read the acting admin in the same transaction
  ([ADR 0005](docs/adr/0005-default-deny-route-guards.md)). CORS allows only
  `CORS_ALLOWED_ORIGINS`.
- **Audit log.** User creation by an admin, role changes and status changes each write an audit
  record in the same transaction as the change. A database trigger rejects every `UPDATE` and
  `DELETE`. Records never hold passwords, hashes, tokens or emails, and only admins read them,
  through `GET /audit` ([ADR 0009](docs/adr/0009-append-only-audit-table.md)).
- **Logs.** Passwords, hashes, tokens and `Authorization` headers are never logged; logs carry ids.

Documented trade-offs (details in [Session trade-offs](#session-trade-offs)):

- **Access tokens stay valid until they expire.** Logout, reuse revocation, disabling a user, a
  password change and a role removal revoke refresh tokens at once. An access token already issued
  stays valid until its `exp` (at most `JWT_ACCESS_TTL_SECONDS`, 15 minutes by default) on
  token-only routes and in downstream services
  ([ADR 0006](docs/adr/0006-status-changes-serialized-and-sessions-revoked.md)).
- **Admin-chosen initial passwords.** `POST /users` sets the password the admin supplies, so the
  admin knows it until the user changes it with `POST /users/me/password`
  ([ADR 0008](docs/adr/0008-admin-creation-and-role-changes-through-the-api.md)).
- **Strict reuse detection.** There is no grace window. A client that retries a refresh after
  losing the response presents a used token and loses the session, so clients must not retry a
  refresh blindly.
- **Registration reveals existing emails.** `POST /auth/register` answers `409` for an email that
  is already used; the per-IP rate limit bounds probing.

## Events

| Topic | Published when | Payload (besides the envelope) |
|---|---|---|
| `identity.user-registered` | A customer registers, after the user is committed (implemented) | `customerId`, `email`, `name` |

Envelope: `eventId`, `aggregateId` (the user id, also the message key), `occurredAt`, `version`.
Orders creates its customer record from this event
([ADR 0004](docs/adr/0004-user-registered-event-choreography.md)). If the publish fails, the
registration still succeeds: the failure is logged and the event is stored in
`outbound_dead_letters` (`PENDING_RETRY`).

**Outbound retry worker.** Every instance runs a timer (`OUTBOUND_RETRY_INTERVAL_MS`) that
republishes due `PENDING_RETRY` rows of `identity.user-registered`, up to
`OUTBOUND_RETRY_BATCH_SIZE` per run, oldest first. Each row is claimed in its own transaction with
`FOR UPDATE SKIP LOCKED`, so instances never process the same row
([ADR 0007](docs/adr/0007-outbound-retry-per-row-skip-locked.md)).

- The stored topic, key and payload are sent unchanged, so the `eventId` is the original one.
  Delivery is **at-least-once**: a consumer may receive the same `eventId` twice and must
  deduplicate on it.
- Success → `RESOLVED`. Failure → retried after
  `min(BASE_DELAY_MS × MULTIPLIER^(attempt − 1), MAX_DELAY_MS)` (defaults: 5, 10, 20, 40, 80, 160,
  then 300 s). After `OUTBOUND_RETRY_MAX_ATTEMPTS` attempts, or at once for a malformed payload
  → `EXHAUSTED`, logged at error level and kept for manual inspection. Final rows are never retried.
- The worker never delays startup or affects `/health` or registration. On shutdown it stops
  claiming rows and waits up to `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS`; unfinished rows stay due.
- Logs carry row id, `eventId`, topic, key, counts and errors, never the payload.

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

### Key rotation runbook

A planned rotation, with no downtime and no forced logout. Below, `current` is the pair in use
(`keys/private.pem`, `keys/public.pem`) and `next` is the new one.

1. **Generate.** `npm run keys:generate -- --name next` writes `keys/next-private.pem` and
   `keys/next-public.pem` and prints the new `kid`. Deliver the private key to every instance
   through your secret store; never commit it.
2. **Pre-publish (only with several instances).** Add `./keys/next-public.pem` to
   `JWT_RETIRED_PUBLIC_KEY_PATHS` and restart every instance. The JWKS now lists the new `kid`,
   which does not sign yet. Wait `JWKS_CACHE_SECONDS` so verifiers' caches pick it up. A single
   instance can skip this step: verifiers refetch on an unknown `kid`.
3. **Switch.** Set `JWT_PRIVATE_KEY_PATH=./keys/next-private.pem` and set
   `JWT_RETIRED_PUBLIC_KEY_PATHS=./keys/public.pem` (the previous public key only: the new public
   key must leave that list, since a duplicate `kid` stops startup). Restart every instance.
4. **Verify.** `curl -s http://localhost:3001/.well-known/jwks.json` lists the new `kid` first and
   the previous one second. A fresh login returns a token whose header `kid` is the new one, and a
   token issued before the switch still works on `GET /users/me`.
5. **Retire.** After `JWT_ACCESS_TTL_SECONDS` plus `JWKS_CACHE_SECONDS` (20 minutes with the
   defaults), every token signed by the previous key has expired. Empty
   `JWT_RETIRED_PUBLIC_KEY_PATHS`, restart, and destroy the previous private key.

**Compromised key.** Don't wait: switch to a new key without listing the compromised public key as
retired, then restart. Every access token it signed is rejected at once. Clients get `401` and call
`POST /auth/refresh` (refresh tokens are opaque and not signed by this key), so sessions survive.
Downstream verifiers drop the old key when their JWKS cache expires.

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
| `OUTBOUND_RETRY_ENABLED` | `true` | Run the outbound retry worker; `false` disables it |
| `OUTBOUND_RETRY_INTERVAL_MS` | `30000` | Pause between retry runs, in ms (integer ≥ 1) |
| `OUTBOUND_RETRY_BATCH_SIZE` | `20` | Rows attempted per run (integer ≥ 1) |
| `OUTBOUND_RETRY_MAX_ATTEMPTS` | `10` | Attempts before a row is `EXHAUSTED` (integer ≥ 1) |
| `OUTBOUND_RETRY_BASE_DELAY_MS` | `5000` | Delay after the first failed attempt, in ms (integer ≥ 1) |
| `OUTBOUND_RETRY_MULTIPLIER` | `2` | Delay growth per failed attempt (number ≥ 1) |
| `OUTBOUND_RETRY_MAX_DELAY_MS` | `300000` | Maximum delay, in ms (integer ≥ base delay) |
| `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS` | `10000` | How long shutdown waits for a run in progress, in ms (integer ≥ 1) |
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
| `RATE_LIMIT_PASSWORD_CHANGE_LIMIT` | `5` | `POST /users/me/password` requests allowed per user id and client IP per window (every request counts) |
| `RATE_LIMIT_PASSWORD_CHANGE_TTL_MS` | `60000` | Length of that window, in ms |
| `JWT_ISSUER` | unset, **required** | `iss` claim of access tokens |
| `JWT_AUDIENCE` | unset, **required** | `aud` claim of access tokens |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime, in seconds |
| `JWT_REFRESH_TTL_SECONDS` | `604800` | Refresh token lifetime, in seconds (7 days) |
| `JWT_SESSION_MAX_SECONDS` | `2592000` | Absolute session lifetime from login, in seconds (30 days); must be at least `JWT_REFRESH_TTL_SECONDS`, otherwise startup fails |
| `JWT_CLOCK_TOLERANCE_SECONDS` | `5` | Clock skew, in seconds, allowed when verifying `exp`, `iat` and `nbf` on protected routes; a non-negative integer, otherwise startup fails |
| `JWT_PRIVATE_KEY_PATH` | unset, **required** | Path of the RS256 private key PEM (e.g. `./keys/private.pem`) |
| `JWT_RETIRED_PUBLIC_KEY_PATHS` | empty | Comma-separated retired public key PEM paths, published after the active key, in order |
| `JWKS_CACHE_SECONDS` | `300` | `max-age` of the key set; a non-negative integer, otherwise startup fails |
| `ADMIN_EMAIL` | unset | Email of the first administrator, created at startup when no admin exists ([Admin seed](#admin-seed)) |
| `ADMIN_PASSWORD` | unset | Password of that administrator; never logged. Remove it after the first start |
| `ADMIN_NAME` | `Administrator` | Display name of that administrator |

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
  commands/        CQRS commands (RegisterCustomerCommand, Login, Refresh, Logout)
  queries/         CQRS queries and read models (GetCurrentUser, ListUsers, GetUser)
  controllers/     HTTP I/O only (routing, DTO validation, response shaping)
  services/        orchestration (command and query handlers, AdminSeedService); no business rules
    ports/         abstractions services depend on (PasswordHasher, UserEventPublisher)
  domain/          aggregates (User, RefreshToken), value objects, domain events — all business rules
  repositories/    persistence behind domain-facing interfaces
  dto/             request/response DTOs (class-validator, Swagger)
  infra/
    database/      TypeORM options, CLI data source, migrations
    kafka/         Kafka module, lazily connecting producer, UserEventsProducer
    outbound/      DeadLetterRetryWorker (timer of the outbound retry worker)
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
