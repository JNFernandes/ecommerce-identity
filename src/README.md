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

**Domain events produced:** `identity.user-registered` (`UserRegistered`, after the user is
committed; contract in `ecommerce-infra/docs/events.md`).

**Shared setup:** `app.setup.ts` (CORS from `CORS_ALLOWED_ORIGINS`, global `ValidationPipe` with
`whitelist` and `forbidNonWhitelisted`) is applied by `main.ts` and by the tests.
