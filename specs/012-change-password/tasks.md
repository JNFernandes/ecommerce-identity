# Tasks: Change your own password (US-12)

**Input**: `specs/012-change-password/` (spec.md, plan.md)
**Tests**: required (constitution VI/VII): unit, integration, component.
**Gate after every task**: build → lint → format:check → test; commit `feat|test|docs(US-12): ...`.

Format: `- [ ] [ID] [P?] [Story?] Description`. Task count kept at 7 per CLAUDE.md (one commit each).
US2 needs no code beyond US1 (revoke-all is in the US1 transaction), so its tests ride with US1;
US4 has no code of its own either (DTO + existing guards), so its tests ride with US3.

## Phase 1: Setup

None: no dependency, migration or config file to create.

## Phase 2: Foundational (blocks every story)

- [X] T001 Add `User.changePassword(newHash: string): User` to `src/domain/user.aggregate.ts`
  (returns a new `User` with only the hash replaced; roles, status, `customerId` unchanged; JSDoc).
  Extend `tests/unit/domain/user.aggregate.spec.ts`: hash replaced, other fields identical, original
  instance untouched.
- [X] T002 Add password-change transaction to `src/repositories/user.repository.ts`: tx interface
  methods `savePasswordHash(user)` and `insertRefreshToken(token)` (map to `refresh_tokens` entity
  like `RefreshTokenRepository.saveWithLogin`), plus `inPasswordChangeTransaction(work)` following the
  `inAdminTransaction` pattern (line ~263). Work order inside: `findByIdForUpdate` →
  `savePasswordHash` → `revokeAllRefreshTokens` (existing) → `insertRefreshToken`. Integration test
  `tests/integration/user-repository-password.integration.spec.ts`: hash stored, every prior token
  revoked, new token active; a throw inside `work` rolls back hash and revocations.

## Phase 3: US1 + US2 – Change my password, other sessions end (P1) 🎯 MVP

**Independent test**: log in twice, change the password from one session → 200 login shape; new
password logs in, old one fails; both old refresh tokens refused; the returned one rotates; the old
access token still works.

- [X] T003 [US1] Create `src/commands/change-password.command.ts`
  (`ChangePasswordCommand(userId, currentPassword, newPassword)`, result `LoginResult`) and
  `src/services/change-password.service.ts` (CQRS handler, register in `src/app.module.ts`). Order:
  re-read user (missing/non-`ACTIVE` → US-05 generic 401 error) → `passwordHasher.verify(current)`
  (mismatch → `InvalidCredentialsError`) → `PasswordPolicy.assertAcceptable(new, email)` →
  `verify(new, oldHash)` true → `UserValidationError` → hash → generate refresh token (new family) →
  `inPasswordChangeTransaction` → sign access token after commit → log `password changed` with user
  id only. Reuse `LoginService` issuing code (lines ~73–110); extract a `SessionIssuer` helper only
  if duplication exceeds a few lines. Unit tests `tests/unit/services/change-password.service.spec.ts`:
  each failure path changes nothing (tx not called); success returns tokens; logs contain no secret.
- [X] T004 [US1] Add `src/dto/change-password.dto.ts` (`currentPassword`, `newPassword`:
  `@IsString`, `@IsNotEmpty`, Swagger + JSDoc; length/email policy stays in domain). Add
  `POST /users/me/password` to `src/controllers/users.controller.ts`: `@Roles(Role.CUSTOMER,
  Role.ADMIN)`, `@HttpCode(200)`, `@UseGuards(ThrottlerGuard)`, response `LoginResponseDto`, map
  `InvalidCredentialsError` → 401 generic, `UserValidationError` → 400. Throttling: add
  `PASSWORD_CHANGE_THROTTLER = 'password-change'` and a `user:<sub>|ip:<ip>` tracker in
  `src/controllers/login-throttle.tracker.ts`; `rateLimit.passwordChange` (env
  `RATE_LIMIT_PASSWORD_CHANGE_LIMIT` / `_TTL_MS`, default 5 / 60000) in `src/config/configuration.ts`;
  register it in `ThrottlerModule.forRootAsync` in `src/app.module.ts`; skip it on every other
  throttled route (auth.controller skip helper line ~67, jwks.controller) and skip the other
  throttlers on this route. Global `JwtAuthGuard` runs before `ThrottlerGuard`, so `req.user` is set.
  Extend `tests/unit/config` for the new env vars.
- [X] T005 [US1] Component test `tests/component/change-password.component.spec.ts`: US1 scenarios
  1–4 (200 login shape, new/old login, returned refresh rotates, admin roles unchanged) and US2
  scenarios 1–3 (two sessions' old refresh tokens refused, returned one accepted, old access token
  still valid); broker unreachable has no effect (FR-010); captured logs contain no password, hash or
  token (SC-005).

## Phase 4: US3 + US4 – Guessing protection, validation and access (P1/P2)

**Independent test**: wrong current password → 401 and nothing changed; 6th attempt → 429; other
user unaffected; bad bodies/policy → 400; no token or disabled user → 401.

- [X] T006 [P] [US3] Component tests `tests/component/change-password-rate-limit.component.spec.ts`
  (US3: wrong current → generic 401, password and sessions unchanged; 6th attempt → 429; different
  user same IP not blocked) and `tests/component/change-password-validation.component.spec.ts`
  (US4: <10, >128, equals email ignoring case, equals current → 400; missing/non-string/extra field →
  400; wrong current + bad new → 401; no/invalid token → 401; disabled or deleted user → generic 401;
  nothing changes in each case).

## Phase 5: Polish & docs

- [X] T007 Docs: `README.md` (endpoint row, rate-limit env vars, trade-off: old access tokens live
  until expiry); `.specify/memory/constitution.md` PATCH 1.1.2 → 1.1.3 resolving
  `TODO(CURRENT_SESSION)` and `TODO(PASSWORD_CHANGE_RATE_LIMIT)` with sync report; `src/README.md`
  flow. No ADR, no `events.md` change. Commit `docs(US-12): ...`.

## Dependencies

- T001 → T002 → T003 → T004 → T005; T006 needs T004 (can run parallel to T005); T007 last.
- US2, US3 and US4 depend on the US1 implementation (T003–T004); no story-specific code.

## Parallel example

After T004: T005 and T006 (separate spec files) in parallel.

## Implementation strategy

MVP = T001–T005 (password change with session revocation, end to end). Then T006 (protection and
validation coverage), then T007 docs. Gate and commit after each task.
