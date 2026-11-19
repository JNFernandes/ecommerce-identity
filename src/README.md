# AppModule

Root module of `ecommerce-identity`.

**Responsibility:** wires configuration (`config/`), PostgreSQL through TypeORM
(`infra/database/`), the Kafka producer (`infra/kafka/`) and the HTTP layer. Layers follow
Controller → Service → Domain → Repository (Constitution Principle I).

**Endpoints:**

- `GET /health` — `HealthController` → `HealthService`. `200` when PostgreSQL answers, `503`
  otherwise; the Kafka producer state is reported but never fails the check.
- `POST /auth/register` — `AuthController` → `CommandBus` → `RegisterCustomerService`. Public,
  rate limited per client IP (`ThrottlerGuard`, throttler `register`). Domain errors map to `400`
  (`UserValidationError`) and `409` (`DuplicateEmailError`).
- `POST /auth/login` — `AuthController` → `CommandBus` → `LoginService`. Public, rate limited by
  the `login-ip` and `login-email` throttlers (`controllers/login-throttle.tracker.ts`); each route
  skips the other route's throttlers with `@SkipThrottle`. `InvalidCredentialsError` maps to the
  generic `401`, `UserValidationError` to `400`.
- `POST /auth/refresh` — `AuthController` → `CommandBus` → `RefreshService`. Public, rate limited
  per client IP (throttler `refresh`). `InvalidRefreshTokenError` (every reason) maps to the
  generic `401` `invalid refresh token`.
- `POST /auth/logout` — `AuthController` → `CommandBus` → `LogoutService`. Public, rate limited per
  client IP (throttler `logout`); always `204` for a well-formed body.
- `GET` / `HEAD /.well-known/jwks.json` — `JwksController` → `JwksService` → `PublicKeySet`
  (`KeyRing`). Public, not throttled (`@SkipThrottle` for every throttler), no Kafka or database.
  Sends the precomputed body with `Cache-Control: public, max-age=<JWKS_CACHE_SECONDS>` and a
  strong `ETag`; a matching `If-None-Match` (`controllers/if-none-match.ts`) gets `304`.
- `GET /users/me` — `UsersController` → `QueryBus` → `GetCurrentUserService` (`@QueryHandler` of
  `GetCurrentUserQuery`) → `UserRepository.findById` → `CurrentUserReadModel` →
  `CurrentUserResponseDto`. `@Roles(CUSTOMER, ADMIN)`. A missing or non-`ACTIVE` user throws
  `InvalidAccessTokenError(USER_UNAVAILABLE)`, the same 401 as a bad token; database errors stay 5xx.
- `GET /users` — `UsersController.list` (`ListUsersQueryDto`) → `QueryBus` → `ListUsersService`
  (`@QueryHandler` of `ListUsersQuery`) → `UserRepository.findPage` → `UserPageReadModel` →
  `UserPageResponseDto`. `@Roles(ADMIN)`. Newest first (`createdAt`, `id` desc), AND filters on
  role, status and a literal, case-insensitive email prefix.
- `GET /users/{id}` — `UsersController.findOne` (`ParseUUIDPipe`, so a malformed id is `400`) →
  `QueryBus` → `GetUserService` (`@QueryHandler` of `GetUserQuery`) →
  `UserRepository.findSummaryById` → `UserSummaryResponseDto`. `@Roles(ADMIN)`. `UserNotFoundError`
  maps to `404 user not found`; declared after `GET /users/me`.
- `GET /docs`, `GET /docs-json` — Swagger UI and OpenAPI document (`app.swagger.ts`).

**Register write flow** (`RegisterCustomerService`):

1. Domain: `Email`, `UserName`, `PasswordPolicy` (checked before hashing), then
   `User.registerCustomer`, which records `UserRegistered`.
2. `PasswordHasher.hash` (argon2id), then `UserRepository.save` — the PostgreSQL commit comes first.
3. `UserEventPublisher.publishUserRegistered` for each pulled domain event. On failure: log topic,
   key, `eventId`, `aggregateId` and cause (never the password or hash), then
   `OutboundDeadLetterRepository.recordFailure` (`PENDING_RETRY`, same `eventId`). The client
   gets `201` either way.

**Outbound retry flow** (US-08, no endpoint):

1. `infra/outbound/DeadLetterRetryWorker` — self-rescheduling, `unref()`'d timer; first run one
   interval after bootstrap (never awaited), next run only after the previous one ends; failures
   logged, never thrown. `onModuleDestroy` stops it before the producer and the pool close.
2. `RetryOutboundEventsService.runBatch` — up to `batchSize` times:
   `OutboundDeadLetterRepository.processNextDue` (one transaction, `FOR UPDATE SKIP LOCKED`) →
   `UserEventPublisher.republish(topic, key, payload)` → domain `decideRetry` → write → commit.
   Logs one summary per non-empty run, one `warn` per rescheduled failure, one `error` per
   exhaustion; never the payload.
3. `domain/outbound/retry-policy.ts` — pure backoff (`nextRetryDelay`) and transitions
   (`decideRetry`: `RESOLVED` / `PENDING_RETRY` / `EXHAUSTED`).

**Folders added by US-01:**

- `services/ports/` — abstract classes the services depend on, used as Nest injection tokens:
  `PasswordHasher`, `UserEventPublisher`. Bound in `AppModule` to their adapters.
- `infra/security/` — `Argon2PasswordHasher` (argon2id, parameters from `ARGON2_*`).
- `infra/kafka/user-events.producer.ts` — `UserEventsProducer`, the Kafka adapter of
  `UserEventPublisher` (through `LazyKafkaProducer`).

**Login flow** (`LoginService`, no event published):

1. `Email.create`, then `UserRepository.findByEmail` (`lower(email)`).
2. Exactly one `PasswordHasher.verify`, against `dummyHash()` when the user is unknown; then the
   user, the result and `User.canLogin()` are checked. Each failure logs its reason and IP and
   throws `InvalidCredentialsError`.
3. `User.recordLogin(Clock.now())`, `TokenIssuer.issue`, `RefreshTokenGenerator.generate`,
   `RefreshToken.issue`, then `RefreshTokenRepository.saveWithLogin` (token hash and
   `users.lastLoginAt` in one transaction).

**Added by US-02:**

- `services/ports/` — `TokenIssuer`, `RefreshTokenGenerator`, `Clock`; `PasswordHasher` gains
  `verify` and `dummyHash`.
- `infra/security/` — `signing-key.ts` (`SigningKey` token, `SigningKeyError`:
  RSA ≥ 2048 bits from `JWT_PRIVATE_KEY_PATH`, `kid` = RFC 7638 thumbprint), `JoseTokenIssuer`
  (RS256), `CryptoRefreshTokenGenerator` (256-bit base64url value, SHA-256 hash).
- `infra/time/` — `SystemClock`, the `Clock` adapter.
- `repositories/refresh-token.repository.ts` — `RefreshTokenRepository` over `refresh_tokens`.
- `AppModule` loads the signing key with an async factory and builds `TokenIssuer` only when
  `JWT_ISSUER` and `JWT_AUDIENCE` are set, so the app fails fast at startup otherwise.

**Added by US-03:**

- `infra/security/key-ring.ts` — `loadKeyRing` reads `JWT_PRIVATE_KEY_PATH` and
  `JWT_RETIRED_PUBLIC_KEY_PATHS` once at startup; `buildKeyRing` validates every key (active RSA
  private key, retired public-only RSA keys, all at least 2048 bits, no duplicate `kid`) and fails
  fast with messages naming files, never key content. `KeyRing` holds the active `SigningKey`, the
  allowlisted public JWKs (active first), the serialized body and its `ETag`.
- `services/ports/public-key-set.ts` — `PublicKeySet` port, bound to `KeyRing`.
- `services/jwks.service.ts` — `JwksService`; `AppModule` builds it with `JWKS_CACHE_SECONDS`
  parsed strictly, so a bad value fails startup. `SigningKey` is now `ring.activeKey`.

**Added by US-04:**

- `domain/refresh-policy.ts` — `RefreshPolicy.decide`: rotate, or refuse with a
  `RefreshFailureReason` and whether to revoke the family. `RefreshToken` gains `assess`,
  `isUsable`, `rotate` and `issueInFamily`; `domain/token-family.ts` (`TokenFamily`) holds the
  absolute session limit (`JWT_SESSION_MAX_SECONDS`).
- `repositories/refresh-token.repository.ts` — `inTransaction(work)` hands the work a
  `RefreshTokenTx` (`findByHash`, `lockFamily`, `findByHashForUpdate`, `findUserById`,
  `familyStartedAt`, `revokeFamily`, `saveRotation`). Lock order is always family lock, then row
  lock.
- **Refresh flow** (`RefreshService`): hash → in one transaction: `findByHash` → `lockFamily` →
  `findByHashForUpdate` → `findUserById` → `RefreshPolicy.decide` → revoke the family, or
  `TokenFamily.nextTokenExpiry` → `TokenIssuer.issue` (current roles, `customerId`) →
  `RefreshToken.issueInFamily` → `rotate` → `saveRotation`. A refusal is returned from the
  transaction and thrown after the commit, so revocations persist.
- **Logout flow** (`LogoutService`): hash → `findByHash` → `lockFamily` → `revokeFamily`; an unknown
  token is a no-op.

**Added by US-05 (access control):**

- `domain/authenticated-principal.ts` — `AuthenticatedPrincipal.fromClaims` (non-empty `sub`,
  non-empty known `roles`, optional non-empty `customerId`) and `hasAnyRole`.
  `domain/errors/invalid-access-token.error.ts` — `InvalidAccessTokenError` (fixed message
  `unauthorized`) and its `AccessTokenFailureReason` (logged only).
- `services/ports/access-token-verifier.ts` — `AccessTokenVerifier` port.
  `infra/auth/jose-access-token-verifier.ts` — `JoseAccessTokenVerifier`: every `KeyRing` JWK
  imported once by `kid`; `jwtVerify` with RS256 only, `iss`, `aud`, `JWT_CLOCK_TOLERANCE_SECONDS`,
  required `sub`/`iat`/`exp`/`jti`, plus an explicit future-`iat` check. No network or file access
  per request.
- `controllers/auth/` — `@Public()`, `@Roles(...)` (also Swagger: bearer, `x-roles`, 401, 403),
  `@CurrentUser()`, `AuthenticatedRequest`; global guards `JwtAuthGuard` (Bearer header → verifier
  → `request.principal`) then `RolesGuard` (403 `forbidden`); `AccessTokenExceptionFilter`
  (`APP_FILTER`, the only 401 mapping, `WWW-Authenticate: Bearer`, reason logged at `warn`);
  `RoutePolicyCheck` (`OnApplicationBootstrap`, via `DiscoveryModule`) fails startup on any route
  without exactly one policy.
- `AuthController`, `JwksController` and `HealthController` are `@Public()` at class level.

**Added by US-06 (admin seed and user listing):**

- `domain/admin-seed-policy.ts` — `AdminSeedPolicy.precheck` (`SKIP_ADMIN_EXISTS`,
  `SKIP_NOT_CONFIGURED`, `PROCEED`) and `decide` (`SKIP_EMAIL_TAKEN`, `CREATE`). `User.registerAdmin`
  creates an `ACTIVE` admin without `customerId` and raises no event.
- `services/admin-seed.service.ts` — `AdminSeedService` (`OnApplicationBootstrap`, after
  migrations): `existsWithRole(ADMIN)` → `precheck` → `Email`, `UserName`, `PasswordPolicy` (an
  error names the variable and rule, never the value) → `findByEmail` → `decide` →
  `PasswordHasher.hash` → `User.registerAdmin` → `save`. Configuration problems are logged and
  skipped; a concurrent `DuplicateEmailError` is a `warn`; database errors fail startup. No
  publisher is injected. Settings: `admin` block of `config/configuration.ts` (`ADMIN_*`).
- `queries/` — `ListUsersQuery`, `GetUserQuery`, and `UserSummaryReadModel` / `UserPageReadModel`
  (no hash, no `updatedAt`), mapped by `UserRepository` directly from the entity.
- `repositories/user.repository.ts` — `existsWithRole`, `findPage` (one query builder, `LIKE`
  wildcards escaped, `getManyAndCount`) and `findSummaryById`.
- Migration `AddUserListIndexes20261118120000` — `IDX_users_created_at_id` and
  `IDX_users_email_lower_prefix` (`lower(email) text_pattern_ops`).

**Added by US-07 (enable or disable a user):**

- `PATCH /users/{id}/status` — `UsersController.changeStatus` (`ParseUUIDPipe`,
  `ChangeUserStatusDto`) → `CommandBus` → `ChangeUserStatusService` (`@CommandHandler` of
  `ChangeUserStatusCommand`). `@Roles(ADMIN)`. `UserNotFoundError` → `404`;
  `CannotDisableSelfError` and `LastActiveAdminError` → `409`; a missing or disabled acting admin
  throws `InvalidAccessTokenError(USER_UNAVAILABLE)`, the generic `401`. No event, no Kafka.
- Domain: `User.assertCanBeDisabledBy` (self rule), `disable`, `enable` (return whether the status
  changed; a no-op writes and logs nothing) and `isActiveAdmin`; `domain/last-active-admin-policy.ts`
  (`LastActiveAdminPolicy.assertCanDisable`).
- `repositories/user.repository.ts` — `inStatusTransaction(work)` hands the work a `UserStatusTx`
  (`lockStatusChanges`, `findById`, `findByIdForUpdate`, `countActiveAdmins`, `saveStatus` writing
  only `status` / `updatedAt`, `revokeAllRefreshTokens`). `queries/user-summary.read-model.ts` gains
  `toUserSummary(user)`, so the response matches `GET /users/{id}`.
- **Status change flow** (one transaction, in this lock order):
  `pg_advisory_xact_lock(USER_STATUS_LOCK_KEY)` → acting admin re-read (`ACTIVE` admin or `401`) →
  target `SELECT … FOR UPDATE` (`404`) → `assertCanBeDisabledBy` → for an `ACTIVE` admin target,
  `countActiveAdmins` + `LastActiveAdminPolicy` → `disable` / `enable` → `saveStatus` → (disable)
  `revokeAllRefreshTokens`. The log line `user status changed: actorId targetId from to
  revokedTokens` is written after the commit. The advisory lock serializes status changes, so
  crossed disables of two admins cannot deadlock and the admin count is exact.
- **Refresh lock order** is now `findByHash` → `lockUserForShare` (`SELECT 1 … FOR SHARE` on the
  user row) → `lockFamily` → `findByHashForUpdate`: a disable waits for an in-flight refresh and
  then revokes its successor, or the refresh waits and sees `DISABLED`.
- **Login**: `RefreshTokenRepository.saveWithLogin` updates `lastLoginAt` only
  `WHERE status = 'ACTIVE'`; with 0 rows it throws `InvalidCredentialsError` and stores no token,
  so a disable that commits between the password check and the save wins.

**Domain events produced:** `identity.user-registered` (`UserRegistered`, after the user is
committed; contract in `ecommerce-infra/docs/events.md`). Customers only: the admin seed publishes
nothing.

**Shared setup:** `app.setup.ts` (CORS from `CORS_ALLOWED_ORIGINS`, global `ValidationPipe` with
`whitelist` and `forbidNonWhitelisted`) is applied by `main.ts` and by the tests.
