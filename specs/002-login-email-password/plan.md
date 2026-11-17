# Implementation Plan: Log in with email and password (US-02)

**Branch**: `feature/US-02-login-email-password` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-login-email-password/spec.md`

## Summary

`POST /auth/login` is public and throttled per IP and per normalized email. It validates `LoginDto` and dispatches `LoginCommand`. The handler normalizes the email, loads the user, and always runs one argon2id verification, against a dummy hash when the user is missing. It then applies `User.canLogin()`, so every failure raises the same `InvalidCredentialsError`, which maps to a generic 401. On success it issues an RS256 access token through `TokenIssuer` (jose, RFC 7638 `kid`) and an opaque 256-bit refresh token through `RefreshTokenGenerator` + `RefreshToken.issue`. The token hash and `lastLoginAt` are stored in one transaction. The signing key is loaded from `JWT_PRIVATE_KEY_PATH` at startup, and startup fails fast without it. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `@nestjs/throttler` 6 (two named throttlers), `jose` 5 (already a dependency), `argon2`, class-validator, `@nestjs/swagger`, TypeORM 0.3. No new packages.

**Storage**: PostgreSQL. New table `refresh_tokens` and a new column `users.lastLoginAt`, created by a migration.

**Testing**: Jest, Supertest, testcontainers (PostgreSQL; Kafka unreachable via a closed port)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: 200 in under 1 s (SC-001), dominated by one argon2id verify

**Constraints**: one verification per attempt whatever the outcome; no password, hash, token or `Authorization` header in logs or error bodies; no timing assertions in tests

**Scale/Scope**: one endpoint, one new aggregate, one new table, one startup key

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | Controller (DTO, 401 mapping) → `LoginService` (orchestration) → domain (`canLogin`, `recordLogin`, `RefreshToken.issue`) → repositories (explicit mapping) |
| II. Security | ✅ | argon2 verify (constant time) plus a dummy hash for unknown emails; one generic error; RS256, 15 min, exact claims, `kid`; key from a file and never committed; refresh token of 256 bits stored as SHA-256 only; login throttled; no secrets logged (tested) |
| III. Authorization | ✅ | Public endpoint per the table; current `status` checked at login; `roles`/`customerId` taken from the stored user |
| IV. Write flow | ✅ | No event in this story. The refresh token and `lastLoginAt` are committed in one transaction before the response |
| V. Types and validation | ✅ | `LoginDto` with whitelist/forbidNonWhitelisted; enums; no `any`; domain error mapped in the controller |
| VI/VII. Tests | ✅ | Unit (domain, handler, issuer, generator), integration (migration, unique hash, repository transaction), component (full app) |
| VIII. Kafka | ✅ | Nothing published; startup still never waits for Kafka |
| IX. Branching | ✅ | On `feature/US-02-login-email-password` |
| X. Quality gate | ✅ | Gate after every task |

Note: the spec adds `User.lastLoginAt` and `RefreshToken.createdAt`, which are not in the constitution's aggregate field lists. These are additive fields, not a violation.

Post-design re-check: no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/002-login-email-password/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  post-auth-login.md  access-token.md
```

### Source Code (new or changed)

```text
scripts/keys-generate.ts                         # npm run keys:generate (R13)
src/
├── commands/login.command.ts
├── controllers/auth.controller.ts               # + POST /auth/login, InvalidCredentialsError → 401, @SkipThrottle per route
├── controllers/login-throttle.tracker.ts        # IP / normalized-email trackers (R12)
├── dto/login.dto.ts, login-response.dto.ts
├── domain/
│   ├── email.value-object.ts                    # + static normalize()
│   ├── user.aggregate.ts                        # + lastLoginAt, canLogin(), recordLogin(at)
│   ├── refresh-token.aggregate.ts
│   └── errors/invalid-credentials.error.ts
├── services/
│   ├── login.service.ts                         # @CommandHandler(LoginCommand), LoginResult
│   └── ports/password-hasher.ts (+verify, dummyHash), token-issuer.ts, refresh-token-generator.ts, clock.ts
├── repositories/user.repository.ts              # + findByEmail, lastLoginAt mapping
├── repositories/refresh-token.repository.ts     # saveWithLogin (one transaction)
├── infra/
│   ├── security/argon2-password-hasher.ts       # + verify, dummy hash on init
│   ├── security/signing-key.ts                  # loadSigningKey, SigningKey, SigningKeyError
│   ├── security/jose-token-issuer.ts
│   ├── security/crypto-refresh-token-generator.ts
│   ├── time/system-clock.ts
│   └── database/entities/refresh-token.entity.ts, user.entity.ts (+lastLoginAt)
│       migrations/20261117140000-CreateRefreshTokensAndUserLastLogin.ts
├── config/configuration.ts                      # + jwt.refreshTtlSeconds, rateLimit.login
└── app.module.ts                                # + providers, async SigningKey factory, login throttlers
tests/  (see below)
```

**Structure Decision**: Same single-project layout as US-01. New ports go in `services/ports/` and their adapters in `infra/security/` and `infra/time/`.

### Tests

- **Unit**:
  - `User.canLogin` / `recordLogin` (ACTIVE, DISABLED throws).
  - `RefreshToken.issue` (new ids, family, expiry, rejects bad ttl or an empty hash).
  - `Email.normalize`.
  - Handler:
    - success returns both tokens and calls `saveWithLogin` once.
    - wrong password.
    - unknown email calls `verify` once with `dummyHash()`.
    - disabled user calls `verify` once.
    - every failure is an `InvalidCredentialsError` and nothing is saved or issued.
  - `JoseTokenIssuer`: exact claims, `kid` equals the thumbprint, `exp = iat + ttl`, no `customerId` when it is null, verifies with the public key, distinct `jti`.
  - `CryptoRefreshTokenGenerator`: 43-character base64url value, 64-hex hash equal to `sha256(value)`, distinct values.
  - `loadSigningKey`: unset, missing, non-RSA and valid key, with no key material in error messages.
  - `Argon2PasswordHasher.verify`.
  - Configuration defaults.
- **Integration (PostgreSQL)**: migration up and down (`refresh_tokens`, `users.lastLoginAt`); `UQ_refresh_tokens_token_hash` rejects a duplicate; `saveWithLogin` stores the token and `lastLoginAt` atomically.
- **Component**:
  - 200 shape; the access token verified with the public key and its decoded claims; two logins give different `jti`, refresh tokens and families.
  - Identical 401 body for unknown, wrong and disabled (disabled set via SQL), with no row written.
  - 400 for an unknown property.
  - 429 after the limit from one IP. All Supertest requests share `127.0.0.1` and `trust proxy` is off, so the per-email bucket across different IPs is covered by a unit test of the tracker (same key for varied IPs and email casing).
  - The refresh token is stored only as its hash.
  - A capturing logger shows no password or token in any log line.
  - With Kafka unreachable, login still returns 200.
  - There are no timing assertions.
- **Test support**: `test-app.ts` writes a temp RSA key and sets the `JWT_*` variables (R14).

### Docs to update

- README: `npm run keys:generate`, the new variables (`JWT_REFRESH_TTL_SECONDS`, `RATE_LIMIT_LOGIN_*`, required `JWT_*`), the token claims, and that the login endpoint is implemented.
- `.env.example`: the new variables and the key path hint.
- ADR 0001: unchanged (R15).

## Complexity Tracking

None.
