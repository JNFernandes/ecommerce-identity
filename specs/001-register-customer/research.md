# Research: Register a customer account (US-01)

No `NEEDS CLARIFICATION` remained after the spec's clarification session. Each entry: decision, then reason.

## R1. Layout follows ecommerce-orders
`src/commands`, `src/services` (CQRS handlers), `src/domain`, `src/repositories`, `src/infra/{database,kafka}`, `src/dto`, `src/controllers`. Same shape as Orders, so both repos read alike. Rejected: a module-per-feature layout, which differs from Orders.

## R2. `@nestjs/cqrs` command + handler
`RegisterCustomerCommand` is dispatched by the controller through `CommandBus`; `RegisterCustomerService` is its `@CommandHandler`. This is how Orders does it (`PlaceOrderService`). Add `@nestjs/cqrs@^10.2.7`, the same version Orders uses.

## R3. Ports for the hasher and the event publisher
`PasswordHasher` and `UserEventPublisher` are abstract classes in `src/services/ports/`. They are used as DI tokens, and unit tests replace them with plain mocks. Rejected: depending on argon2 or kafkajs directly in the handler, which Orders does, but which would put infrastructure in the handler's unit tests.

## R4. Validation split: DTO for shape, domain for rules
DTO: `@IsString` and `@IsNotEmpty` on exactly the three fields. The global `ValidationPipe` (already `whitelist` + `forbidNonWhitelisted`) rejects unknown properties such as `roles`. Domain: `Email` (trim, lowercase, at most 254 characters, format), `UserName` (trim, 1–100 code points), `PasswordPolicy` (10–128 code points, not equal to the normalized email, case-insensitive, compared after trimming). Rules live only in the domain (Principle I). Their errors map to 400 in the controller.

## R5. Rules are checked before hashing
The handler builds `Email` and `UserName` and checks `PasswordPolicy` before calling `hasher.hash`, so invalid input never costs an argon2 run.

## R6. argon2id with parameters from configuration
`Argon2PasswordHasher` (`src/infra/security/`) uses `type: argon2id` with `ARGON2_MEMORY_COST_KIB` (65536), `ARGON2_TIME_COST` (3) and `ARGON2_PARALLELISM` (4). The defaults are the `argon2` library's own. Tests lower them to stay fast.

## R7. Uniqueness enforced by the database
A unique index on `lower(email)` decides; there is no read-before-write check. `UserRepository.save` turns PG error `23505` (using Orders' `isUniqueViolation`) into the domain `DuplicateEmailError`. The controller maps that to `409 "email already registered"`. A read-then-insert check would race under concurrency (SC-005).

## R8. Write flow and the dead letter
Save the user (single insert, committed). Then `publisher.publishUserRegistered(event)`. On failure: log topic, key, `eventId`, `aggregateId` and cause, then `OutboundDeadLetterRepository.recordFailure` (`PENDING_RETRY`, `retryCount` 0, `nextRetryAt` = now). The client still gets 201. If the dead-letter write itself fails, it is logged at error level and the client still gets 201, because the user is already committed. This mirrors Orders' `PlaceOrderService`.

## R9. Domain event raised by the aggregate
`User.registerCustomer` records a `UserRegistered` event (eventId from `crypto.randomUUID`, version 1). The handler takes it with `pullDomainEvents()`, as Orders does. Principle I: the domain raises the event and infrastructure publishes it.

## R10. Lazy producer reused
`UserEventsProducer` implements `UserEventPublisher` on top of the bootstrap `LazyKafkaProducer`. No new connection logic. A publish to an unreachable broker takes about 3 s with the current defaults, inside SC-004's 5 s.

## R11. Rate limiting
`ThrottlerModule.forRootAsync` with one named throttler, `register`. Its limit comes from `RATE_LIMIT_REGISTER_LIMIT` (5) and its window from `RATE_LIMIT_REGISTER_TTL_MS` (60000). `ThrottlerGuard` is applied only on the register route, so `/health` is never throttled. The limit is keyed by the default tracker, the client IP. Trusted-proxy configuration is a deployment concern and is not added here.

## R12. Persistence naming follows Orders
TypeORM entities in `src/infra/database/entities/` with column names as Orders has them. PostgreSQL enums `user_role_enum` (used as an array column) and `user_status_enum`. `customerId` is nullable and unique, because admins will have none (Principle III).

## R13. Tests
Unit tests: the domain (pure) and the handler with mocked ports and repositories. Integration tests: testcontainers PostgreSQL for the migration, the case-insensitive unique index, `UserRepository` and `OutboundDeadLetterRepository`. Component tests: the full app with testcontainers PostgreSQL and Kafka (add `@testcontainers/kafka`, the version family Orders uses). Orders' `createTopicsWhenReady` helper is copied in. In the Kafka-unreachable case, brokers point to a closed port. A capturing `LoggerService` collects every log line so tests can assert that neither the password nor the hash appears in any of them.

## R14. ecommerce-infra contract
`identity.user-registered` is **missing** from `ecommerce-infra/docs/events.md` and from the `kafka-init` topic list. The spec (Assumptions) requires adding both, so this is an exception to "only if the payload differs". It is a linked change on a branch in ecommerce-infra. The payload is the envelope plus `customerId`, `email` and `name`, matching the README.
