---
description: "Task list for US-02: Log in with email and password"
---

# Tasks: Log in with email and password (US-02)

**Input**: `specs/002-login-email-password/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US4]` are the spec's stories (log in / refuse / throttle / signing key). All commits use the repo story scope `US-02`.

**Order** (as requested): domain → hasher → migration and repository → token issuance → command handler → controller, error mapping and throttling → component tests → docs.
- **Password policy**: not applied at login. `LoginDto` only requires a non-empty string, so policy changes never lock out existing users. No policy task.
- **Event publisher / dead-letter fallback**: not applicable. Login publishes no event (plan IV/VIII). It is replaced by a Kafka-unreachable component test (T020) for FR-014.

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup

- [X] T001 Add `jwt.refreshTtlSeconds` (`JWT_REFRESH_TTL_SECONDS`, default 604800) and `rateLimit.login` (`RATE_LIMIT_LOGIN_LIMIT` 10, `RATE_LIMIT_LOGIN_TTL_MS` 60000) with JSDoc in `src/config/configuration.ts`. Extend `tests/unit/config/configuration.spec.ts` (defaults and overrides). Commit `feat(US-02): add refresh token and login rate limit settings`.
- [ ] T002 [P] In `tests/component/support/test-app.ts`, add `useTestSigningKey()`: generate a 2048-bit RSA pair in memory, write the PKCS#8 private key to a temp file, set `JWT_PRIVATE_KEY_PATH`, `JWT_ISSUER=ecommerce-identity-test`, `JWT_AUDIENCE=ecommerce-test`, and return the public `KeyObject`. Call it from `startPostgres()` so every existing component test has a key (R14). Commit `test(US-02): provide a temporary signing key to component tests`.

---

## Phase 2: Foundational (domain, hasher, persistence, token issuance)

**Purpose**: Everything the login handler needs. Blocks every story. No endpoint yet.

### Domain

- [ ] T003 [P] Extract `static normalize(raw: string): string` (`trim().toLowerCase()`) in `src/domain/email.value-object.ts` and use it inside `Email.create`. Tests in `tests/unit/domain/email.value-object.spec.ts`: `" Ana@Example.com "` → `ana@example.com`; `create` unchanged. Commit `refactor(US-02): extract Email.normalize`.
- [ ] T004 [P] Add `InvalidCredentialsError` (message `invalid credentials`, JSDoc) in `src/domain/errors/invalid-credentials.error.ts`. Extend `tests/unit/domain/errors.spec.ts` (name, message, `instanceof Error`). Commit `feat(US-02): add InvalidCredentialsError`.
- [ ] T005 Add `lastLoginAt: Date | null` (null after `registerCustomer`, kept by `restore`), `canLogin()` (`status === ACTIVE`) and `recordLogin(at)` (sets `lastLoginAt`, leaves `updatedAt`, throws `InvalidCredentialsError` when `!canLogin()`) in `src/domain/user.aggregate.ts` (depends on T004). Tests in `tests/unit/domain/user.aggregate.spec.ts`: ACTIVE logs in, DISABLED throws and `lastLoginAt` stays null, `updatedAt` unchanged. Commit `feat(US-02): add login rules to User`.
- [ ] T006 [P] Create the `RefreshToken` aggregate with `issue({ userId, tokenHash, issuedAt, ttlSeconds })` (new UUID `id` and `familyId`, `createdAt = issuedAt`, `expiresAt = issuedAt + ttl`, `revokedAt`/`replacedBy` null; rejects ttl ≤ 0 or empty hash) and `restore(props)` in `src/domain/refresh-token.aggregate.ts`. No I/O; UUIDs via `node:crypto` `randomUUID` as in `User`. Tests in `tests/unit/domain/refresh-token.aggregate.spec.ts`: fields, expiry, distinct ids/families across two issues, rejections, restore round-trip. Commit `feat(US-02): add RefreshToken aggregate`.

### Hasher

- [ ] T007 Add `verify(plain, hash): Promise<boolean>` and `dummyHash(): string` to `src/services/ports/password-hasher.ts`. Implement them in `src/infra/security/argon2-password-hasher.ts`: `verify` via `argon2.verify` (false on a malformed hash, never throws for a mismatch); `onModuleInit` hashes 32 random bytes once with the configured parameters; `dummyHash()` throws if called before init. Update the `PasswordHasher` mock in `tests/unit/services/register-customer.service.spec.ts`. Tests in `tests/unit/infra/argon2-password-hasher.spec.ts`: right password true, wrong false, `"secret "` ≠ `"secret"`, dummy hash is an argon2id string that verifies false for any input. Commit `feat(US-02): add password verification and dummy hash`.
- [ ] T008 [P] Add the `Clock` port (`now(): Date`, abstract class) in `src/services/ports/clock.ts` and `SystemClock` in `src/infra/time/system-clock.ts`. Test in `tests/unit/infra/system-clock.spec.ts`. Commit `feat(US-02): add Clock port`.

### Migration and repositories

- [ ] T009 Create migration `src/infra/database/migrations/20261117140000-CreateRefreshTokensAndUserLastLogin.ts` (`refresh_tokens` per data-model.md: FK to `users(id)` ON DELETE CASCADE, `IDX_refresh_tokens_user_id`, `IDX_refresh_tokens_family_id`, `UQ_refresh_tokens_token_hash`; `users."lastLoginAt"` via `ADD COLUMN IF NOT EXISTS`; `down()` reverses), `RefreshTokenEntity` in `src/infra/database/entities/refresh-token.entity.ts`, `lastLoginAt` on `src/infra/database/entities/user.entity.ts`, and register the entity in `src/infra/database/typeorm-options.ts`. Integration test `tests/integration/refresh-tokens-migration.integration.spec.ts`: up creates table, indexes, unique constraint and column; duplicate `tokenHash` rejected; down removes them. Commit `feat(US-02): add refresh_tokens table and users.lastLoginAt`.
- [ ] T010 Add `findByEmail(normalized: string): Promise<User | null>` (`lower(email)` lookup) and map `lastLoginAt` both ways in `src/repositories/user.repository.ts` (depends on T005, T009). Extend `tests/integration/user.repository.integration.spec.ts`: found with normalized email, null when unknown, `lastLoginAt` round-trips. Commit `feat(US-02): find users by email`.
- [ ] T011 Create `RefreshTokenRepository` with `saveWithLogin(token: RefreshToken, user: User)` in `src/repositories/refresh-token.repository.ts`: one `DataSource.transaction` inserting the mapped entity and updating only `users."lastLoginAt"` (R11); explicit entity ↔ domain mapping. Integration test `tests/integration/refresh-token.repository.integration.spec.ts`: both writes visible; a duplicate hash rolls back the `lastLoginAt` update. Commit `feat(US-02): persist refresh token and last login atomically`.

### Token issuance

- [ ] T012 [P] Implement `loadSigningKey(path)`, `SigningKey` (`privateKey: KeyObject`, `kid`) and `SigningKeyError` in `src/infra/security/signing-key.ts` (R8: PKCS#8/PKCS#1, RSA ≥ 2048 bits, `kid` = `calculateJwkThumbprint` sha256). Tests in `tests/unit/infra/signing-key.spec.ts` with temp files: unset, not found, not a key, EC key, 1024-bit RSA each throw a message naming the problem and containing no PEM content; valid key gives a stable `kid` across two loads. Commit `feat(US-02): load the RS256 signing key from a PEM file`.
- [ ] T013 Add the `TokenIssuer` port (`issue(subject: AccessTokenSubject, issuedAt: Date): Promise<IssuedAccessToken>`) in `src/services/ports/token-issuer.ts` and `JoseTokenIssuer` in `src/infra/security/jose-token-issuer.ts` (R9; depends on T012). Tests in `tests/unit/infra/jose-token-issuer.spec.ts`: header `{alg RS256, kid, typ JWT}`, exactly the contract claims, `exp = iat + ttl`, no `customerId` when null, verifies with the public key, distinct `jti`, `expiresIn` = ttl. Commit `feat(US-02): issue RS256 access tokens`.
- [ ] T014 [P] Add the `RefreshTokenGenerator` port (`generate() → { value, hash }`, `hash(value)`) in `src/services/ports/refresh-token-generator.ts` and `CryptoRefreshTokenGenerator` in `src/infra/security/crypto-refresh-token-generator.ts` (R10). Tests in `tests/unit/infra/crypto-refresh-token-generator.spec.ts`: 43-char base64url value, 64-hex hash equal to `sha256(value)`, distinct values. Commit `feat(US-02): generate opaque refresh tokens`.
- [ ] T015 Wire providers in `src/app.module.ts`: async `SigningKey` factory from `jwt.privateKeyPath`, `TokenIssuer` factory that fails fast when `jwt.issuer`/`jwt.audience` are unset, `RefreshTokenGenerator`, `Clock`, `RefreshTokenRepository` and `RefreshTokenEntity` (depends on T002, T008–T014). Existing component tests must stay green with the T002 key. Commit `feat(US-02): wire token issuance providers`.

**Checkpoint**: domain, ports, adapters and persistence ready; the app starts only with a valid key.

---

## Phase 3: User Story 1 - Log in and receive tokens (Priority: P1) 🎯 MVP

**Goal**: An active user gets an access token and a refresh token from `POST /auth/login`.

**Independent Test**: Register, log in, check the 200 body, the token header and claims, and the hashed refresh token row.

- [ ] T016 [US1] Create `LoginCommand` (`email`, `password`, `clientIp`) in `src/commands/login.command.ts` and `LoginService` (`@CommandHandler(LoginCommand)`, returns `LoginResult`) in `src/services/login.service.ts`, success path only: `Email.create` → `findByEmail` → `verify` → `recordLogin(clock.now())` → `TokenIssuer.issue` → `generate()` → `RefreshToken.issue` → `saveWithLogin`; log `login succeeded` with user id and IP only. Register the handler in `src/app.module.ts`. Tests in `tests/unit/services/login.service.spec.ts`: result shape, `tokenType` `Bearer`, `saveWithLogin` called once with the hash (never the value), `customerId`/roles passed to the issuer. Commit `feat(US-02): add login command handler`.
- [ ] T017 [P] [US1] Create `LoginDto` (`email`, `password`: `@IsString`, `@IsNotEmpty`, no trim on password) in `src/dto/login.dto.ts` and `LoginResponseDto` in `src/dto/login-response.dto.ts`, `@ApiProperty` on every field. Tests in `tests/unit/dto/login.dto.spec.ts` (class-validator: missing, non-string, empty) and `tests/unit/dto/login-response.dto.spec.ts`. Commit `feat(US-02): add login DTOs`.
- [ ] T018 [US1] Add public `POST /auth/login` (`@HttpCode(200)`, `@ApiOkResponse`, `@ApiBadRequestResponse`) to `src/controllers/auth.controller.ts`, dispatching `LoginCommand` with `req.ip` and returning `LoginResponseDto` (depends on T016, T017). Extend `tests/unit/controllers/auth.controller.spec.ts`. Commit `feat(US-02): expose POST /auth/login`.
- [ ] T019 [US1] Component test `tests/component/login.component.spec.ts`: register then log in with `" Ana@Example.com "` → 200 with exactly the four fields and `expiresIn` 900; the access token verifies with the T002 public key and has exactly the contract claims; two logins give different `jti`, refresh tokens and `familyId`; the row holds `sha256(refreshToken)` (not the value), `expiresAt` = createdAt + 7 days, `revokedAt` null; `users."lastLoginAt"` set. Commit `test(US-02): cover successful login end to end`.
- [ ] T020 [P] [US1] Component test `tests/component/login-kafka-unavailable.component.spec.ts`: with `useUnreachableKafka()`, a seeded user (registered while Kafka is down) logs in with 200 (FR-014, SC-007). Commit `test(US-02): cover login with Kafka unreachable`.

**Checkpoint**: MVP — a registered user can log in.

---

## Phase 4: User Story 2 - Refuse failed logins without revealing accounts (Priority: P1)

**Goal**: Every failure is the same 401 after exactly one password verification.

**Independent Test**: Unknown email, wrong password and disabled user give byte-identical 401 bodies with no row written.

- [ ] T021 [US2] Complete `src/services/login.service.ts` per R5: always one `verify(password, user?.passwordHash ?? dummyHash())`, then check user, result and `canLogin()`; each failure throws `InvalidCredentialsError` and logs `login failed` with reason (`unknown_email` / `wrong_password` / `inactive`) and IP, never the email-password pair, hash or token. Extend `tests/unit/services/login.service.spec.ts`: unknown email verifies once with `dummyHash()`, wrong password, disabled verifies once; every failure is `InvalidCredentialsError`; issuer, generator and `saveWithLogin` never called; a repository error propagates unchanged (not 401). Commit `feat(US-02): refuse failed logins with one generic error`.
- [ ] T022 [US2] Map `InvalidCredentialsError` to `UnauthorizedException('invalid credentials')` in the login route of `src/controllers/auth.controller.ts` and add `@ApiUnauthorizedResponse`. Extend `tests/unit/controllers/auth.controller.spec.ts` (401 body exactly `{statusCode:401,message:'invalid credentials',error:'Unauthorized'}`; other errors rethrown). Commit `feat(US-02): map invalid credentials to 401`.
- [ ] T023 [US2] Component test `tests/component/login-failures.component.spec.ts`: unknown email, wrong password, `"secret "` vs `"secret"`, and a user disabled via SQL all return byte-identical 401 bodies; no `refresh_tokens` row and `lastLoginAt` unchanged; 400 for missing field, non-string, empty password, malformed JSON, unknown property and bad email format; a `CapturingLogger` sees no password, hash, token or `Authorization` header in any line (SC-005). Commit `test(US-02): cover failed logins and secret-free logs`.

**Checkpoint**: US1 + US2 give a secure, complete login.

---

## Phase 5: User Story 3 - Slow down credential stuffing (Priority: P2)

**Goal**: At most 10 login requests per minute per IP and per normalized email.

**Independent Test**: The 11th request from one IP gets 429; the email tracker keys varied IPs and casings to one bucket.

- [ ] T024 [P] [US3] Create `loginThrottleTracker(kind: 'ip' | 'email')` in `src/controllers/login-throttle.tracker.ts` (R12: `req.ip`; `Email.normalize(body.email)`; `ip:<ip>` fallback when `email` is not a string). Tests in `tests/unit/controllers/login-throttle.tracker.spec.ts`: same email key for varied IPs and casing/spaces, fallback key, IP key. Commit `feat(US-02): add login throttle trackers`.
- [ ] T025 [US3] Register the `login-ip` and `login-email` throttlers (shared `rateLimit.login` limit/ttl, per-throttler `getTracker`) in `src/app.module.ts`; on `src/controllers/auth.controller.ts` add `ThrottlerGuard` and `@ApiTooManyRequestsResponse` to login, `@SkipThrottle({ [REGISTER_THROTTLER]: true })` on login and `@SkipThrottle({ 'login-ip': true, 'login-email': true })` on register (depends on T024). Existing `tests/component/register-rate-limit.component.spec.ts` must stay green. Commit `feat(US-02): rate limit login by IP and email`.
- [ ] T026 [US3] Component test `tests/component/login-rate-limit.component.spec.ts` (low limit via env): requests up to the limit are processed, the next gets 429 without a credential check (hasher spy or log), and registration from the same IP is unaffected. Window reset covered with a short `RATE_LIMIT_LOGIN_TTL_MS`. Commit `test(US-02): cover login rate limiting`.

---

## Phase 6: User Story 4 - Operate the signing key safely (Priority: P2)

**Goal**: Developers generate a key with one command; the service refuses to start without a valid one.

**Independent Test**: Run `npm run keys:generate`; start the app with no, missing or invalid key and see a clear error.

- [ ] T027 [P] [US4] Create `scripts/keys-generate.ts` exporting `generateKeys(dir, { force })` (2048-bit RSA, `private.pem` PKCS#8 mode 0600, `public.pem`, refuses to overwrite without `--force`, prints paths and `kid`, never key material) with a CLI entry point; add `"keys:generate": "ts-node scripts/keys-generate.ts"` and `scripts/**/*.ts` to the `lint`, `format` and `format:check` globs in `package.json`. Tests in `tests/unit/scripts/keys-generate.spec.ts` (temp dir: files written, loadable by `loadSigningKey`, refusal without force, overwrite with force). Commit `feat(US-02): add npm run keys:generate`.
- [ ] T028 [US4] Component test `tests/component/signing-key-startup.component.spec.ts`: `createTestApp()` rejects with a `SigningKeyError` naming the problem for unset, missing and non-RSA key paths, and an error for unset `JWT_ISSUER`; messages contain no `BEGIN` / key material; with a valid key the JWT `kid` equals the thumbprint and is the same across two app starts. Commit `test(US-02): cover signing key fail-fast at startup`.

---

## Phase 7: Polish and docs

- [ ] T029 [P] Update `README.md`: `npm run keys:generate`, new variables (`JWT_REFRESH_TTL_SECONDS`, `RATE_LIMIT_LOGIN_LIMIT`, `RATE_LIMIT_LOGIN_TTL_MS`, required `JWT_PRIVATE_KEY_PATH`/`JWT_ISSUER`/`JWT_AUDIENCE`), the access token claims, and `POST /auth/login` as implemented. Commit `docs(US-02): document login, keys and token settings`.
- [ ] T030 [P] Update `.env.example` with the new variables, defaults and `./keys/private.pem` hint; update `src/README.md` with the new ports and `infra/security` / `infra/time` adapters. Commit `docs(US-02): describe login settings and ports`.
- [ ] T031 Run the quickstart scenarios in `specs/002-login-email-password/quickstart.md` against local infra and mark them done there. Commit `docs(US-02): mark quickstart validation complete`.

---

## Dependencies

- **Setup (T001–T002)** → **Foundational (T003–T015)** → stories.
- Inside Foundational: T004 → T005; T005 + T009 → T010 → T011; T012 → T013; T008–T014 → T015.
- **US1 (T016–T020)** needs Foundational. **US2 (T021–T023)** extends US1's handler and route, so it follows US1.
- **US3 (T024–T026)** needs only the login route (T018); it can run in parallel with US2 apart from both editing `auth.controller.ts` (do T022 and T025 one after the other).
- **US4 (T027–T028)** needs only T012 and T015; it can run after Foundational in parallel with US1–US3.
- **Docs (T029–T031)** after all stories.

## Parallel examples

- Foundational: T003, T004, T006, T008, T012, T014 (separate files, no shared dependency).
- US1: T017 while T016 is in progress; T020 alongside T019.
- After T018: T024 (US3) and T027 (US4) alongside US2.
- Docs: T029 and T030 together.

## Implementation strategy

1. **MVP**: Phases 1–3 (T001–T020). Login works end to end; stop and validate with quickstart scenarios 1–3.
2. **Secure release**: add US2 (T021–T023). This is the minimum shippable, since both stories are P1.
3. Add US3 (throttling) and US4 (key tooling), then docs. Each phase leaves the gate green and is one commit per task.
