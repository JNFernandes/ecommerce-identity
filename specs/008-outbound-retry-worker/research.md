# Research: Outbound dead-letter retry worker (US-08)

Facts checked on `main` (US-07 merged): `outbound_dead_letters` already has `status`
(`PENDING_RETRY`/`RESOLVED`/`EXHAUSTED`), `retryCount`, `nextRetryAt`, `lastAttemptAt`, `lastError`,
`resolvedAt` and the `(status, nextRetryAt)` index; `main.ts` calls `enableShutdownHooks()`;
`@nestjs/schedule` is not installed; `LazyKafkaProducer.publish` always keys by `aggregateId`.
Reference: `ecommerce-orders` `specs/006-dead-letter-retry` and `src/infra/dead-letter/`.

## R1. No migration
**Decision**: Reuse the table as is. **Why**: every column the input lists (`resolvedAt`,
`lastError`, `EXHAUSTED`) already exists since US-01. **Rejected**: an empty "safety" migration.

## R2. Scheduling: self-rescheduling `setTimeout` in `DeadLetterRetryWorker`
**Decision**: First run one interval after `onApplicationBootstrap` (never awaited); each run
schedules the next only after it finishes; timer `unref()`'d. Same as Orders. **Why**: no overlap
(FR-010), no startup delay (FR-009), no new dependency. **Rejected**: `setInterval` (overlaps when
publishes time out), `@nestjs/schedule` (new dependency, still needs a re-entrancy guard).

## R3. Shutdown hook: `onModuleDestroy`, not `onApplicationShutdown`
**Decision**: Stop the timer and await the in-flight run in `onModuleDestroy`. **Why**: Nest runs
every `onModuleDestroy` before any `onApplicationShutdown`; `LazyKafkaProducer` disconnects and
TypeORM closes the pool in `onApplicationShutdown`, so stopping there could race them.
**Deviation from the input**, which asked for `OnApplicationShutdown`; matches Orders.

## R4. Claiming: one row per transaction, `FOR UPDATE SKIP LOCKED`, lock held during publish
**Decision**: `OutboundDeadLetterRepository.processNextDue(handler)` opens a transaction, selects
one due row (`topic = identity.user-registered`, `PENDING_RETRY`, `nextRetryAt <= now()`, order
`nextRetryAt, createdAt`) via query builder `setLock('pessimistic_write')` +
`setOnLocked('skip_locked')`, runs the handler, writes its update, commits. The service repeats
it up to `batchSize` times per run. **Why**: exclusivity across instances (FR-002); a crash or
shutdown rolls back and releases the row unchanged, so no lease bookkeeping (FR-011); a lock lasts
one publish only. **Rejected**: one transaction for the whole batch (20 rows locked across slow
publishes, one connection held minutes while Kafka is down); claim-with-lease then publish outside
the transaction (needs a lease longer than the worst batch). **Note**: the input's "each batch is
claimed inside a transaction" becomes "each row of the batch", as in Orders.

## R5. Layering: worker → service → domain policy → repository / publisher port
**Decision**: `DeadLetterRetryWorker` (infra) only schedules and calls
`RetryOutboundEventsService.runBatch()` (services), which orchestrates claim → publish → decide →
log. The pure policy (`nextRetryDelay`, `decideRetry`) lives in `src/domain/outbound/`.
**Why**: constitution I forbids rules in services; the policy has no I/O so it fits the domain.
**Deviation from the input**, which put the backoff calculator in the service layer.

## R6. Republish path
**Decision**: Add `republish(topic, key, payload)` to the `UserEventPublisher` port, implemented by
`UserEventsProducer` through a new `LazyKafkaProducer.publishRaw(topic, key, value)`. **Why**: the
stored key is sent as is (not re-derived) and the stored payload is not rebuilt from a domain event.
**Note**: `jsonb` does not keep key order, so the value has the same fields and values but may
differ byte-wise; `eventId` is unchanged, which is what consumers deduplicate on.

## R7. Outcomes
**Decision**: Success → `RESOLVED`, `resolvedAt` set, `lastError` cleared (the original failure stays
in `error`). Publish error → transient (backoff or `EXHAUSTED` at `maxAttempts`). Malformed row (payload
not an object with string `eventId`) → permanent, `EXHAUSTED` at once. `retryCount` increments on
every attempt. **Why**: retrying a malformed row cannot succeed; counts stay equal to attempts.

## R8. Configuration
**Decision**: `outboundRetry` section in `src/config/configuration.ts`: `OUTBOUND_RETRY_ENABLED`
(true), `_INTERVAL_MS` (30000), `_BATCH_SIZE` (20), `_MAX_ATTEMPTS` (10), `_BASE_DELAY_MS` (5000),
`_MULTIPLIER` (2), `_MAX_DELAY_MS` (300000). Invalid values throw at config load naming the
variable. **Why**: same pattern as existing `parseNonNegativeInteger`; the enabled flag lets tests
drive runs manually (Orders does the same).

## R9. Logging
**Decision**: per non-empty run one `log` line (claimed/resolved/failed/exhausted); per failure one
`warn` (row id, `eventId`, topic, attempt, next attempt); per exhaustion one `error` (+ key, last
error); run failure one `error`. Never the payload. **Why**: FR-013/FR-014.

## R10. Tests
**Decision**: unit — policy (delay table, cap, transitions), service (mocked repo/publisher/clock),
config parsing, worker timer (fake timers); integration — `processNextDue` on real PostgreSQL incl.
two concurrent claimers and rollback on handler throw; component — Kafka stopped → register 201 +
row stored → Kafka back → run → message with same `eventId`/key and row `RESOLVED`; Kafka down with
`maxAttempts` small → `EXHAUSTED`; startup and `/health` with due rows and no Kafka.
