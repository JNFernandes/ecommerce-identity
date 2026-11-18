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
- `GET /docs`, `GET /docs-json` — Swagger UI and OpenAPI document (`app.swagger.ts`).

**Register write flow** (`RegisterCustomerService`):

1. Domain: `Email`, `UserName`, `PasswordPolicy` (checked before hashing), then
   `User.registerCustomer`, which records `UserRegistered`.
2. `PasswordHasher.hash` (argon2id), then `UserRepository.save` — the PostgreSQL commit comes first.
3. `UserEventPublisher.publishUserRegistered` for each pulled domain event. On failure: log topic,
   key, `eventId`, `aggregateId` and cause (never the password or hash), then
   `OutboundDeadLetterRepository.recordFailure` (`PENDING_RETRY`, same `eventId`). The client
   gets `201` either way.

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

**Domain events produced:** `identity.user-registered` (`UserRegistered`, after the user is
committed; contract in `ecommerce-infra/docs/events.md`).

**Shared setup:** `app.setup.ts` (CORS from `CORS_ALLOWED_ORIGINS`, global `ValidationPipe` with
`whitelist` and `forbidNonWhitelisted`) is applied by `main.ts` and by the tests.
