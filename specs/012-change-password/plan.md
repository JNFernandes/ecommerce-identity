# Implementation Plan: Change your own password (US-12)

**Branch**: `feature/US-12-change-password` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

## Summary

`POST /users/me/password` (CUSTOMER, ADMIN): verify the current password, apply `PasswordPolicy`,
then in one transaction store the new hash, revoke every refresh token of the user and store a new
refresh token (new family) for the caller; return the login response shape. Rate limited per user
id + IP. No Kafka, no audit.

## Technical Context

- **Stack**: TypeScript strict, NestJS 10 CQRS, TypeORM + PostgreSQL, `argon2`, `@nestjs/throttler`,
  Jest + testcontainers.
- **Storage**: existing `users.passwordHash` and `refresh_tokens`. No migration, no new table.
- **Constraints**: generic 401 for wrong password and non-`ACTIVE` caller; no secrets in logs. No
  NEEDS CLARIFICATION (both constitution TODOs settled in the spec).

## Constitution Check

| Principle | Status |
|-----------|--------|
| I Layering | PASS: controller (DTO, error mapping) → `ChangePasswordService` (orchestrate) → `User.changePassword` + `PasswordPolicy` (domain) → `UserRepository` tx. |
| II Security | PASS: argon2id verify (constant-time), generic 401, policy reused, all refresh tokens revoked, new opaque token stored hashed, user id only in logs. |
| III Roles | PASS: `@Roles(Role.CUSTOMER, Role.ADMIN)`; caller re-read, non-`ACTIVE` → US-05 401. |
| IV Write flow | PASS: single DB transaction; no event, works without Kafka. |
| V Validation | PASS: whitelist + `forbidNonWhitelisted`, `IsString` on both fields. |
| VI/VII Tests | PASS: unit (domain), integration (tx revoke + hash), component (endpoint, sessions, throttle, access). |
| XI Audit | N/A: self-service, not an admin mutation (spec assumption). |

## Design decisions

- **Domain**: `User.changePassword(newHash)` returns a new `User` with the hash replaced (roles,
  status, `customerId` untouched). `PasswordPolicy.assertAcceptable` reused; "same as current" is
  checked in the service via `passwordHasher.verify(new, oldHash)` → `UserValidationError` → 400.
- **Order of checks**: DTO 400 → throttle 429 → re-read user (401) → verify current (401) → policy
  and "differs" (400) → hash → tx. Current password first, so policy errors leak nothing.
- **Command**: `ChangePasswordCommand(userId, currentPassword, newPassword)` in `src/commands/`;
  result reuses `LoginResult`.
- **Transaction**: new `UserRepository.inPasswordChangeTransaction` (or reuse `inAdminTransaction`'s
  pattern): `findByIdForUpdate` (serializes concurrent changes) → `savePasswordHash` →
  `revokeAllRefreshTokens` (exists) → insert new `RefreshToken`. Tokens issued after commit-safe
  generation; access token signed after commit.
- **Token issuing**: extract the access+refresh issuing from `LoginService` into a small shared
  helper (`SessionIssuer`) if duplication exceeds a few lines; otherwise inline.
- **Rate limit**: new named throttler `password-change` (`rateLimit.passwordChange`, default 5/60 s,
  env-configurable) with tracker `user:<sub>|ip:<ip>`; `@SkipThrottle` for it on other routes. The
  JWT guard must run before the throttler guard so `req.user` is set (verify guard order in
  `UsersController`).
- **API**: `ChangePasswordDto` (Swagger + JSDoc), response `LoginResponseDto`; `InvalidCredentialsError`
  → 401 generic, `UserValidationError` → 400 (existing mappings).
- **Docs**: README endpoint row + trade-off (old access tokens live until expiry) + rate-limit env
  var; constitution PATCH 1.1.2 → 1.1.3 resolving `CURRENT_SESSION` and
  `PASSWORD_CHANGE_RATE_LIMIT`; `src/README.md` flow. No ADR, no `events.md` change.

## Project Structure

```text
src/domain/user.aggregate.ts                        # + changePassword
src/commands/change-password.command.ts
src/services/change-password.service.ts
src/repositories/user.repository.ts                 # + password-change tx methods
src/dto/change-password.dto.ts
src/controllers/users.controller.ts                 # + POST me/password
src/controllers/login-throttle.tracker.ts, src/config/configuration.ts, src/app.module.ts
tests/unit/change-password.service.spec.ts, tests/unit/user.aggregate.spec.ts (extend)
tests/integration/user-repository-password.integration.spec.ts
tests/component/change-password*.component.spec.ts  # success+sessions, throttle, validation/access
```

## Suggested tasks (5–6)

1. Domain `changePassword` + unit tests.
2. Repository tx (lock, hash, revoke all, insert token) + integration test.
3. Command + service + throttler config/tracker + unit tests.
4. DTO + endpoint + Swagger.
5. Component tests (US1–US4, edge cases, no secrets in logs).
6. Docs: README, constitution PATCH, `src/README.md`.

## Complexity Tracking

None.
