# Implementation Plan: Refresh the session and log out (US-04)

**Branch**: `feature/US-04-refresh-logout` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-refresh-logout/spec.md`

## Summary

`POST /auth/refresh` and `POST /auth/logout` are public, throttled per IP, and take a `RefreshTokenDto`.

`RefreshService` (`@CommandHandler(RefreshCommand)`) hashes the token and runs one transaction:

1. Read the token by hash without a lock to learn its family, take the family advisory lock, then re-read the row `FOR UPDATE`. Every family writer takes the family lock before any row lock, so rotation, reuse and logout cannot deadlock (R9).
2. The domain `RefreshPolicy.decide` classifies the request: unknown, reuse (revoke the family), expired, inactive user (revoke the family), or rotate. The service only executes that decision (Principle I).
3. Compute the next expiry with the `TokenFamily` session limit.
4. Issue the access token through the existing `TokenIssuer`, using the current roles and `customerId`.
5. Rotate the token and save the rotation.

The handler throws a single `InvalidRefreshTokenError` after the commit, so revocations persist. The controller maps it to a generic 401.

`LogoutService` revokes the family when the token is known, and the endpoint always returns 204.

No new package and no migration are needed. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `@nestjs/throttler` 6 (two new named throttlers), TypeORM 0.3 (`pessimistic_write`), `jose` through `TokenIssuer`, class-validator, `@nestjs/swagger`. No new packages.

**Storage**: PostgreSQL. The existing `refresh_tokens` table and its indexes are enough, so there is no schema change (R5, R6).

**Testing**: Jest, Supertest, testcontainers (PostgreSQL; Kafka on a closed port)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: refresh answers in under 1 s (SC-001). The work is a few indexed queries and one RS256 signature, with no argon2.

**Constraints**:
- At most one success per token, including concurrent requests.
- Every refresh failure returns a byte-identical 401.
- No token or hash appears in logs or error bodies.
- Revocations commit even though the request fails.

**Scale/Scope**: two endpoints, one value object, one error type, and aggregate methods. No table changes.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | The controller handles DTOs and the 401 and 204 mapping. The services orchestrate. The domain holds `assess`, `isUsable`, `rotate`, `issueInFamily`, `TokenFamily` and `RefreshPolicy` (which failures revoke the family); the services only execute its decision. The repository owns the transaction (`RefreshTokenTx`). |
| II. Security | ✅ | Tokens are looked up by SHA-256 hash only. Tokens are single use and rotated atomically. Reuse revokes the family. Successors have 256 bits of entropy. Failures return one generic 401. Both endpoints are throttled. No tokens are logged (tested). |
| III. Authorization | ✅ | Both endpoints are public with a refresh token, as listed in the constitution's endpoint table. Refresh checks the current `status` and uses the current `roles` and `customerId`. |
| IV. Write flow | ✅ | No event is published. The state change commits before the response. |
| V. Types and validation | ✅ | `RefreshTokenDto` uses whitelist and forbidNonWhitelisted. Results are enums. There is no `any`. Domain errors are mapped in the controller. |
| VI/VII. Tests | ✅ | Unit, integration (PostgreSQL) and component tests (below), including the rotation and reuse tests the constitution requires. The register → login → refresh → logout flow runs against a real Kafka testcontainer. |
| VIII. Kafka | ✅ | Nothing is published. A separate component test proves refresh and logout work with Kafka unreachable. |
| IX. Branching | ✅ | Work is on `feature/US-04-refresh-logout`. |
| X. Quality gate | ✅ | The gate runs after every task. |

Post-design re-check: there are no violations and no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/004-refresh-logout/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  post-auth-refresh.md  post-auth-logout.md
```

### Source Code (new or changed)

```text
src/
├── commands/refresh.command.ts, logout.command.ts
├── controllers/auth.controller.ts               # + POST /auth/refresh (401 mapping), POST /auth/logout (@HttpCode 204), skips
├── controllers/login-throttle.tracker.ts        # + REFRESH_THROTTLER, LOGOUT_THROTTLER names
├── dto/refresh-token.dto.ts                     # shared by both endpoints; response reuses LoginResponseDto
├── domain/
│   ├── refresh-token.aggregate.ts               # + issueInFamily, assess, isUsable, rotate
│   ├── refresh-token-state.enum.ts
│   ├── token-family.ts                          # session limit rule
│   ├── refresh-policy.ts                        # decide(): rotate | refuse(reason, revokeFamily)
│   └── errors/invalid-refresh-token.error.ts    # + RefreshFailureReason
├── services/refresh.service.ts, logout.service.ts
├── repositories/refresh-token.repository.ts     # + inTransaction(work) with RefreshTokenTx (R7, R9)
├── repositories/user.repository.ts              # mapper made reusable by RefreshTokenTx.findUserById
├── config/configuration.ts                      # + jwt.sessionMaxSeconds (validated), rateLimit.refresh/logout
└── app.module.ts                                # + handlers, two throttlers
docs/adr/0002-refresh-token-rotation-with-reuse-detection.md   # + "Update (US-04)" section (R20)
README.md, .env.example
```

**Structure Decision**: This story keeps the single-project layout from US-01 to US-03 and needs no new port, because `TokenIssuer`, `RefreshTokenGenerator.hash` and `Clock` already exist.

### Tests

**Unit**

- `RefreshToken`:
  - `assess` covers usable, expired, revoked, and expired-and-revoked (which counts as `REUSED`).
  - `isUsable` at the exact `expiresAt` returns false.
  - `rotate` sets `revokedAt` and `replacedBy`, and throws on a token that is not usable.
  - `issueInFamily` keeps the family and gets a new id.
- `TokenFamily`:
  - the result is `min(now + ttl, start + max)`;
  - the session cap applies;
  - an expired session gives `SESSION_EXPIRED`.
- `RefreshPolicy`: unknown, reused (revoke), expired-unused (no revoke), expired-and-revoked (reused, revoke), inactive user (revoke), usable + active → rotate.
- `RefreshService` uses a fake `RefreshTokenTx`:
  - success issues tokens and saves the rotation;
  - unknown;
  - expired (the family is not revoked);
  - reused (the family is revoked, then it throws);
  - revoked;
  - disabled user (the family is revoked);
  - current roles and `customerId` are passed to `TokenIssuer`;
  - every failure is an `InvalidRefreshTokenError`, and nothing is issued.
- `LogoutService`: a known token revokes the family; an unknown token is a no-op.
- `AuthController` mapping: refresh errors become 401 and logout returns 204.
- `RefreshTokenDto` validation.
- Configuration: defaults, and a session limit below the refresh TTL throws.

**Integration (PostgreSQL)**

- `inTransaction` + `saveRotation` commit the old and new rows atomically. A failure inside the work rolls both back.
- `revokeFamily` updates only unrevoked rows of that family.
- `familyStartedAt` returns the login row's `createdAt`.
- Two concurrent transactions on the same hash: the second sees `revokedAt` after the first commits.
- A reuse that runs while the newest token is being rotated still leaves no live token in the family, and neither transaction fails with a deadlock (`40P01`) (family lock first, R9).

**Component**

- Refresh returns a working access token (verified through the JWKS) and a working refresh token, and the old token returns 401.
- Reuse revokes the family, so even the newest token returns 401.
- Two parallel refreshes with one token give exactly one 200.
- Logout followed by refresh returns 401.
- Logout with an unknown token returns 204.
- The session limit is enforced, with a short `JWT_SESSION_MAX_SECONDS`, a controlled clock, and a check on `expiresAt`.
- The 401 bodies are identical across failure causes.
- 400 for an unknown property.
- 429 for each endpoint.
- No token value or hash appears in the captured logs.
- With Kafka unreachable, refresh and logout succeed.
- The full token flow (register → login → refresh → logout) runs against a real Kafka testcontainer (constitution VII).

### Docs to update

- **README**:
  - document the two endpoints;
  - add `JWT_SESSION_MAX_SECONDS` and `RATE_LIMIT_REFRESH_*` / `RATE_LIMIT_LOGOUT_*` to the configuration table;
  - add the trade-off notes: access tokens stay valid after logout until `exp`; strict reuse detection with no grace window means a retried refresh ends the session; expired rows are not purged yet.
- **`.env.example`**: add the new variables.
- **ADR 0002**: add the update section (R20).

## Complexity Tracking

None.
