---
description: "Task list for US-04: Refresh the session and log out"
---

# Tasks: Refresh the session and log out (US-04)

**Input**: `specs/004-refresh-logout/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US6]` are the spec's stories (refresh / reuse / generic failures / session limit / logout / throttle). All commits use the repo story scope `US-04`.

**Scope notes**:
- No migration and no new package (R5, R6). No Kafka event (R19).
- Every refresh failure is one `InvalidRefreshTokenError`, thrown by the handler **after** the transaction commits (R8), mapped to `UnauthorizedException('invalid refresh token')` in the controller (R13).

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup (configuration)

- [X] T001 Add `jwt.sessionMaxSeconds` (`JWT_SESSION_MAX_SECONDS`, default 2592000, parsed with `parseNonNegativeInteger`) with JSDoc in `src/config/configuration.ts`; the loader throws `JWT_SESSION_MAX_SECONDS must be >= JWT_REFRESH_TTL_SECONDS` when it is smaller (R17). Extend `tests/unit/config/configuration.spec.ts`: default, override, negative/non-numeric rejected, smaller than refresh TTL rejected, equal accepted. Commit `feat(US-04): add the absolute session limit setting`.
- [X] T002 Add `rateLimit.refresh` (`RATE_LIMIT_REFRESH_LIMIT` 30, `RATE_LIMIT_REFRESH_TTL_MS` 60000) and `rateLimit.logout` (`RATE_LIMIT_LOGOUT_LIMIT` 30, `RATE_LIMIT_LOGOUT_TTL_MS` 60000) to `RateLimitConfig` with JSDoc in `src/config/configuration.ts` (R16; same file as T001, so sequential). Extend `tests/unit/config/configuration.spec.ts` (defaults and overrides). Commit `feat(US-04): add refresh and logout rate limit settings`.

---

## Phase 2: Foundational (domain, DTO, transactional repository, commands)

**Purpose**: Everything the refresh and logout handlers need. Blocks every story. No endpoint yet.

### Domain

- [X] T003 [P] Create the `RefreshTokenState` enum (`USABLE`, `EXPIRED`, `REUSED`) with JSDoc in `src/domain/refresh-token-state.enum.ts`. Covered by T005's tests; commit together with T005 if preferred, otherwise commit `feat(US-04): add RefreshTokenState`.
- [X] T004 [P] Create `RefreshFailureReason` enum (`UNKNOWN`, `EXPIRED`, `REUSED`, `INACTIVE_USER`, `SESSION_EXPIRED`) and `InvalidRefreshTokenError` (fixed message `invalid refresh token`, readonly `reason`, JSDoc) in `src/domain/errors/invalid-refresh-token.error.ts` (R13). Extend `tests/unit/domain/errors.spec.ts`: name, message identical for every reason, `reason` kept, `instanceof Error`. Commit `feat(US-04): add InvalidRefreshTokenError`.
- [X] T005 Add `assess(now)` (revoked → `REUSED` first, then `now >= expiresAt` → `EXPIRED`, else `USABLE`), `isUsable(now)`, `rotate(newTokenId, now)` (sets `revokedAt`/`replacedBy`; throws when not usable or id empty) and `static issueInFamily({ userId, familyId, tokenHash, issuedAt, expiresAt })` (new id, given family, `createdAt = issuedAt`; throws on empty hash or `expiresAt <= issuedAt`) to `src/domain/refresh-token.aggregate.ts` (R2, R3; depends on T003). Extend `tests/unit/domain/refresh-token.aggregate.spec.ts`: usable, expired, revoked, expired-and-revoked → `REUSED`, `isUsable` false exactly at `expiresAt`, rotate sets fields and throws on revoked/expired, `issueInFamily` keeps family with a new id and rejects bad input. Commit `feat(US-04): add rotation rules to RefreshToken`.
- [X] T006 [P] Create the `TokenFamily` value object (`create({ startedAt, maxSeconds })` rejecting `maxSeconds <= 0`, `expiresAt`, `nextTokenExpiry(now, refreshTtlSeconds)` = `min(now + ttl, expiresAt)`, throwing `InvalidRefreshTokenError(SESSION_EXPIRED)` when the result is `<= now`) in `src/domain/token-family.ts` (R4; depends on T004). Tests in `tests/unit/domain/token-family.spec.ts`: ttl wins when far from the cap, cap wins near the end, exactly at the cap throws `SESSION_EXPIRED`, invalid `maxSeconds` rejected. Commit `feat(US-04): add TokenFamily session limit rule`.
- [X] T006a Create `RefreshPolicy.decide({ token, user, now }): RefreshDecision` (`{ kind: 'rotate' } | { kind: 'refuse', reason: RefreshFailureReason, revokeFamily: boolean }`) with JSDoc in `src/domain/refresh-policy.ts`: revoked → `REUSED` + revoke; expired → `EXPIRED`, no revoke; user not `canLogin()` → `INACTIVE_USER` + revoke; else rotate (constitution I: which failures revoke the family is business logic; depends on T004, T005). Tests in `tests/unit/domain/refresh-policy.spec.ts`: each branch, expired-and-revoked → `REUSED` + revoke, expired token of an inactive user → `EXPIRED` without revoke. Commit `feat(US-04): add RefreshPolicy`.

### DTO

- [X] T007 [P] Create `RefreshTokenDto` (`refreshToken`: `@IsString`, `@IsNotEmpty`, `@MaxLength(512)`, `@ApiProperty` with example) in `src/dto/refresh-token.dto.ts` (R15). Tests in `tests/unit/dto/refresh-token.dto.spec.ts` (class-validator): valid, missing, non-string, empty, 513 chars rejected. Commit `feat(US-04): add RefreshTokenDto`.

### Persistence

- [X] T008 [P] Make the user entity → domain mapper reusable: export a `toUserDomain(entity: UserEntity): User` function (or make `UserRepository.toDomain` public static) in `src/repositories/user.repository.ts`, with JSDoc; no behavior change. Existing `tests/integration/user.repository.integration.spec.ts` must stay green. Commit `refactor(US-04): expose the user entity mapper`.
- [X] T009 Add `RefreshTokenRepository.inTransaction<T>(work: (tx: RefreshTokenTx) => Promise<T>): Promise<T>` and the `RefreshTokenTx` interface (JSDoc on each method) in `src/repositories/refresh-token.repository.ts` (R7, R9; depends on T005, T008): `findByHash(hash)` (no lock) and `findByHashForUpdate(hash)` (`lock: { mode: 'pessimistic_write' }`), both mapping entity → `RefreshToken.restore`, with JSDoc stating the lock order `findByHash` → `lockFamily` → `findByHashForUpdate` (R9), `lockFamily(familyId)` (`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`), `findUserById(id)` (same manager, T008 mapper), `familyStartedAt(familyId)` (`MIN("createdAt")`), `revokeFamily(familyId, at)` (only rows with `revokedAt IS NULL`, returns affected count), `saveRotation(rotated, next)` (update old row's `revokedAt`/`replacedBy`, insert new row). Extend `tests/integration/refresh-token.repository.integration.spec.ts`: rotation commits both rows; an error thrown inside `work` rolls both back; `revokeFamily` leaves other families and already-revoked rows untouched; `familyStartedAt` returns the login row's `createdAt`; `findByHashForUpdate` returns null for an unknown hash. Commit `feat(US-04): add the refresh token transaction`.
- [X] T010 Integration test for locking in `tests/integration/refresh-token-locking.integration.spec.ts` (depends on T009): two concurrent `inTransaction` calls on the same hash — the second sees `revokedAt` set after the first commits (R10); a family revoke started while the newest token is being rotated leaves no live token in the family and neither transaction fails with a deadlock (`40P01`); same for a logout racing a rotation (family lock first, R9). Commit `test(US-04): cover row and family locking`.

### Commands

- [X] T011 [P] Create `RefreshCommand` (`refreshToken`, `clientIp`) in `src/commands/refresh.command.ts` and `LogoutCommand` (`refreshToken`, `clientIp`) in `src/commands/logout.command.ts`, with JSDoc (R1). No tests beyond compilation. Commit `feat(US-04): add refresh and logout commands`.

**Checkpoint**: domain rules, DTO, transaction and commands ready; build and integration tests green.

---

## Phase 3: User Story 1 - Keep a session alive with a refresh token (Priority: P1) 🎯 MVP

**Goal**: `POST /auth/refresh` exchanges a valid refresh token for a new access token and refresh token.

**Independent Test**: Log in, refresh, check the 200 body, claims, the stored rotation and that the new token works once.

- [X] T012 [US1] Create `RefreshService` (`@CommandHandler(RefreshCommand)`, returns `LoginResult`) in `src/services/refresh.service.ts`, implementing the full R11 order inside `inTransaction` with an outcome union `issued | refused(reason)` and throwing `InvalidRefreshTokenError(reason)` only after the transaction returns (R8): hash → `findByHash` (unknown → `UNKNOWN`) → `lockFamily` → `findByHashForUpdate` → `findUserById` → `RefreshPolicy.decide` (refuse: `revokeFamily` only when the decision says so; depends on T006a) → `TokenFamily.nextTokenExpiry` (`familyStartedAt`, `jwt.sessionMaxSeconds`, `jwt.refreshTtlSeconds`) → `TokenIssuer.issue` with current roles/`customerId` → `generate()` → `issueInFamily` → `rotate` → `saveRotation`. Log `refresh succeeded` with `userId`, `familyId`, `ip` only. Register the handler in `src/app.module.ts`. Tests in `tests/unit/services/refresh.service.spec.ts` with a fake `RefreshTokenTx`: success issues tokens and saves the rotation with the hash (never the value); current roles and `customerId` passed to the issuer; new expiry from `TokenFamily`. Commit `feat(US-04): add refresh command handler`.
- [X] T013 [US1] Add public `POST /auth/refresh` (`@HttpCode(200)`, body `RefreshTokenDto`, `@ApiOkResponse(LoginResponseDto)`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`) to `src/controllers/auth.controller.ts`, dispatching `RefreshCommand` with `req.ip` and mapping `InvalidRefreshTokenError` to `UnauthorizedException('invalid refresh token')`; other errors propagate (depends on T007, T011, T012). Extend `tests/unit/controllers/auth.controller.spec.ts`: success returns the result, every `RefreshFailureReason` gives the same 401, an unrelated error is rethrown. Commit `feat(US-04): expose POST /auth/refresh`.
- [X] T014 [US1] Component test `tests/component/refresh.component.spec.ts`: register, log in, refresh → 200 with exactly the four login fields; access token verifies through `GET /.well-known/jwks.json`, has the login claim set and a new `jti`; old row has `revokedAt` and `replacedBy` = new row id, new row stores `sha256(newRefreshToken)` in the same family; a chain of three refreshes each succeeds once; a role/`customerId` read from the current user record (update the row directly, then refresh). Commit `test(US-04): cover successful refresh end to end`.

**Checkpoint**: MVP — sessions can be extended.

---

## Phase 4: User Story 2 - Detect a stolen refresh token (Priority: P1)

**Goal**: A used or revoked token revokes its whole family and returns 401.

**Independent Test**: Refresh once, reuse the original token → 401, then the newest token → 401.

- [X] T015 [US2] Extend `tests/unit/services/refresh.service.spec.ts` for reuse (code from T012; fix if a case fails): a revoked token calls `revokeFamily` then throws `REUSED` and issues nothing; an expired-and-revoked token is `REUSED`; reuse logs a warn `refresh token reuse detected` with `userId`, `familyId`, `ip` and no token or hash (add the warn in `src/services/refresh.service.ts` if missing). Commit `test(US-04): cover refresh token reuse in the handler`.
- [ ] T016 [US2] Component test `tests/component/refresh-reuse.component.spec.ts`: refresh RT1 → RT2; reuse RT1 → 401 and every row of the family has `revokedAt`; RT2 → 401; 10 parallel refreshes with one fresh token give exactly one 200 and the family ends fully revoked (SC-002, SC-003). Commit `test(US-04): cover reuse detection and concurrent refresh`.

---

## Phase 5: User Story 3 - Refuse invalid refreshes without revealing why (Priority: P1)

**Goal**: Unknown, expired, reused and inactive-user failures are byte-identical 401s; bad bodies are 400.

**Independent Test**: Compare the 401 bodies for each cause; send malformed bodies.

- [ ] T017 [US3] Extend `tests/unit/services/refresh.service.spec.ts`: unknown hash → `UNKNOWN`, no lock or revoke; expired unused → `EXPIRED`, family not revoked; disabled user → `revokeFamily` then `INACTIVE_USER`; in every failure `TokenIssuer.issue` and `saveRotation` are not called and the reason is logged as `refresh refused reason=…`. Commit `test(US-04): cover refresh refusals in the handler`.
- [ ] T018 [US3] Component test `tests/component/refresh-failures.component.spec.ts`: unknown, expired (row `expiresAt` set in the past), reused and disabled-user tokens each return 401 with the byte-identical body `{"statusCode":401,"message":"invalid refresh token","error":"Unauthorized"}`; disabled user's family revoked, expired-unused family not revoked; missing field, number, empty string, malformed JSON and unknown property each return 400 on `POST /auth/refresh`. Commit `test(US-04): cover generic refresh failures and validation`.

---

## Phase 6: User Story 4 - Enforce an absolute session lifetime (Priority: P2)

**Goal**: No refresh token outlives `familyStart + JWT_SESSION_MAX_SECONDS`.

**Independent Test**: With a short session limit, refresh near and past the limit.

- [ ] T019 [US4] Extend `tests/unit/services/refresh.service.spec.ts`: near the cap the new `expiresAt` equals `familyStartedAt + sessionMaxSeconds`; past the cap the handler throws `SESSION_EXPIRED` and issues nothing. Commit `test(US-04): cover the session limit in the handler`.
- [ ] T020 [US4] Component test `tests/component/refresh-session-limit.component.spec.ts`: start the app with `JWT_SESSION_MAX_SECONDS` = `JWT_REFRESH_TTL_SECONDS` = 60 and a controllable `Clock` override; refresh at +30 s → new row `expiresAt` = login + 60 s; at +61 s → 401. Startup with `JWT_SESSION_MAX_SECONDS` below the refresh TTL fails with the T001 message. Commit `test(US-04): cover the absolute session limit end to end`.

---

## Phase 7: User Story 5 - Log out (Priority: P2)

**Goal**: `POST /auth/logout` always returns 204 and revokes the family of a known token.

**Independent Test**: Log out, then refresh with the same token → 401; log out with unknown/revoked tokens → 204.

- [ ] T021 [US5] Create `LogoutService` (`@CommandHandler(LogoutCommand)`) in `src/services/logout.service.ts` (R14): hash → `inTransaction`: `findByHash`; unknown → no-op; known → `lockFamily` + `revokeFamily(familyId, clock.now())` (family lock before any row lock, R9); log `logout` with `userId`, `familyId`, `ip`. Register the handler in `src/app.module.ts`. Tests in `tests/unit/services/logout.service.spec.ts`: known token revokes the family, unknown token touches nothing, a repository error propagates. Commit `feat(US-04): add logout command handler`.
- [ ] T022 [US5] Add public `POST /auth/logout` (`@HttpCode(204)`, body `RefreshTokenDto`, `@ApiNoContentResponse`, `@ApiBadRequestResponse`) to `src/controllers/auth.controller.ts`, returning nothing (depends on T021). Extend `tests/unit/controllers/auth.controller.spec.ts`: dispatches `LogoutCommand` with the IP and resolves to `undefined`. Commit `feat(US-04): expose POST /auth/logout`.
- [ ] T023 [US5] Component test `tests/component/logout.component.spec.ts`: log in, refresh, log out with the latest token → 204 empty body, every family row revoked with `replacedBy` unchanged, refresh with it → 401; logout with unknown, already-revoked and expired tokens → 204; unknown property → 400; an access token issued before logout still verifies through the JWKS (documented trade-off). One case runs the full token flow register → login → refresh → logout against a real Kafka testcontainer (constitution VII), reusing the `register-customer` container setup. Commit `test(US-04): cover logout end to end`.

---

## Phase 8: User Story 6 - Throttle refresh and logout (Priority: P3)

**Goal**: Per-IP limits on both endpoints, without affecting register and login buckets.

**Independent Test**: Exceed each limit from one IP and check 429.

- [ ] T024 [US6] Add `REFRESH_THROTTLER = 'refresh'` and `LOGOUT_THROTTLER = 'logout'` (JSDoc) to `src/controllers/login-throttle.tracker.ts`; register both throttlers keyed by IP from `rateLimit.refresh`/`rateLimit.logout` in `src/app.module.ts`; add `@UseGuards(ThrottlerGuard)` to refresh and logout and update every `@SkipThrottle` in `src/controllers/auth.controller.ts` so each route skips all throttlers except its own (R16); add `@ApiTooManyRequestsResponse` to both. Existing register/login rate-limit component tests must stay green. Commit `feat(US-04): rate limit refresh and logout per IP`.
- [ ] T025 [US6] Component test `tests/component/refresh-logout-rate-limit.component.spec.ts` with low limits (e.g. 2 per minute): third refresh from one IP → 429 and no token row read/changed; third logout → 429; refresh traffic does not consume the login or logout buckets. Commit `test(US-04): cover refresh and logout rate limits`.

---

## Phase 9: Polish & cross-cutting

- [ ] T026 [P] Component test `tests/component/refresh-logout-kafka-unavailable.component.spec.ts`: with `useUnreachableKafka()`, a seeded user logs in, refreshes (200) and logs out (204) (FR-012, SC-008). Commit `test(US-04): cover refresh and logout with Kafka unreachable`.
- [ ] T027 [P] Component test `tests/component/refresh-logout-logging.component.spec.ts` using `tests/component/support/capturing-logger.ts`: run success, reuse, unknown, 400, 429 and logout flows; no captured line or error body contains any refresh token value, its SHA-256 hash, an access token or an `Authorization` header (FR-011, SC-007). Commit `test(US-04): assert no tokens in logs or error bodies`.
- [ ] T028 [P] Update `README.md`: document `POST /auth/refresh` and `POST /auth/logout`; add `JWT_SESSION_MAX_SECONDS`, `RATE_LIMIT_REFRESH_*`, `RATE_LIMIT_LOGOUT_*` to the configuration table; add trade-offs (access tokens valid after logout until `exp`, strict reuse with no grace window, expired rows not purged) (FR-013). Commit `docs(US-04): document refresh, logout and their trade-offs`.
- [ ] T029 [P] Add `JWT_SESSION_MAX_SECONDS=2592000`, `RATE_LIMIT_REFRESH_LIMIT`, `RATE_LIMIT_REFRESH_TTL_MS`, `RATE_LIMIT_LOGOUT_LIMIT`, `RATE_LIMIT_LOGOUT_TTL_MS` with comments to `.env.example` (FR-015). Commit `docs(US-04): add session and rate limit settings to .env.example`.
- [ ] T030 [P] Add a dated "Update (US-04)" section to `docs/adr/0002-refresh-token-rotation-with-reuse-detection.md` (session limit and derived start, strict reuse, family advisory lock, logout revokes the family, purge deferred) and refresh its line in `docs/adr/README.md` if the summary changes (R20). Commit `docs(US-04): record the US-04 update in ADR 0002`.
- [ ] T031 [P] Update `src/README.md` with the new endpoints, `RefreshService`/`LogoutService`, `TokenFamily` and `RefreshTokenTx`. Commit `docs(US-04): list refresh and logout in the module README`.
- [ ] T032 Run `specs/004-refresh-logout/quickstart.md` manually against `npm run start:dev` and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-04): record the manual quickstart run`.

---

## Dependencies & execution order

- **Setup (T001–T002)** → **Foundational (T003–T011)** → stories.
- Inside Foundational: T003 → T005; T004 → T006; T005 + T006 → T006a; T005 + T008 → T009 → T010.
- **US1 (T012–T014)** depends on all Foundational tasks (T012 on T006a) and is the MVP.
- **US2, US3, US4** depend on US1 (they test branches of the T012 handler and the T013 endpoint) and are independent of each other, but share `tests/unit/services/refresh.service.spec.ts` (T015, T017, T019 are sequential).
- **US5 (T021–T023)** depends only on Foundational (T009, T011) and T007; it can run in parallel with US1–US4 except for the shared `auth.controller.ts`/`app.module.ts` edits (T013 before T022).
- **US6 (T024–T025)** depends on T013 and T022 (both routes exist).
- **Polish** after US6; T026–T031 are parallel (different files); T032 last.

```text
T001→T002→{T003,T004,T007,T008,T011}→T005,T006→T006a,T009→T010
        └→ US1 T012→T013→T014 ─┬→ US2 T015→T016
                               ├→ US3 T017→T018
                               └→ US4 T019→T020
           US5 T021→T022→T023 (after T013)
           US6 T024→T025 → Polish T026..T031 [P] → T032
```

## Parallel examples

- Foundational: T003, T004, T007, T008, T011 in parallel (separate files).
- After US1: T016 (US2 component), T018 (US3 component), T020 (US4 component) in parallel — separate spec files; the unit-test tasks T015/T017/T019 stay sequential.
- Polish: T026, T027, T028, T029, T030, T031 in parallel.

## Implementation strategy

1. **MVP**: Phases 1–3 (T001–T014) — refresh works end to end with reuse already enforced by the handler.
2. Harden: US2 and US3 prove the security guarantees (reuse, identical 401s).
3. Add US4 (session cap verification) and US5 (logout).
4. Add US6 throttling, then polish (Kafka-down, log hygiene, docs, quickstart).
5. Gate green and commit after every task; open the PR "Implements US-04: Refresh the session and log out" after T032.
