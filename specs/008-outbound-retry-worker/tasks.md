---
description: "Task list for US-08: Retry failed user-registered events"
---

# Tasks: Retry failed user-registered events (US-08)

**Input**: `specs/008-outbound-retry-worker/` (plan.md, spec.md, research.md, data-model.md, contracts/retry-worker.md, quickstart.md)

**Tests**: Requested (plan R10, constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US4]` are the spec's stories (delivery / backoff and exhaustion / several instances and shutdown / never harms the service). All commits use the repo story scope `US-08`.

**Scope notes**:
- No migration, no new package (R1, R2). `outbound_dead_letters` is used as is.
- Only `identity.user-registered` rows are claimed (FR-001, FR-015).
- One transaction per row: claim with `FOR UPDATE SKIP LOCKED` → publish → `decideRetry` → write → commit; up to `batchSize` rows per run (R4).
- Shutdown in `onModuleDestroy`, never `onApplicationShutdown` (R3).
- Payloads (and any field of them) are never logged (FR-014).

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup

No setup tasks: no package or migration changes (plan "Technical Context"). Settings are added in T001.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: settings, the pure retry policy, the raw republish path and the per-row claim every story uses.

- [ ] T001 [P] Add the `outboundRetry` section to `src/config/configuration.ts` (R8, contracts "Settings"): exported `OutboundRetryConfig` interface with JSDoc (`enabled`, `intervalMs`, `batchSize`, `maxAttempts`, `baseDelayMs`, `multiplier`, `maxDelayMs`), read from `OUTBOUND_RETRY_ENABLED` (`true`), `OUTBOUND_RETRY_INTERVAL_MS` (30000), `OUTBOUND_RETRY_BATCH_SIZE` (20), `OUTBOUND_RETRY_MAX_ATTEMPTS` (10), `OUTBOUND_RETRY_BASE_DELAY_MS` (5000), `OUTBOUND_RETRY_MULTIPLIER` (2), `OUTBOUND_RETRY_MAX_DELAY_MS` (300000), `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS` (10000, field `shutdownTimeoutMs`); reuse the existing parse helpers' style; integers ≥ 1, multiplier a number ≥ 1, max delay ≥ base delay; invalid → throw `<VARIABLE> must be ...` naming the variable. Add the variables with defaults and one-line comments to `.env.example`. Extend `tests/unit/config/configuration.spec.ts`: defaults; overrides; `ENABLED=false`; each invalid case (`0`, `-1`, `abc`, `1.5` for integers, multiplier `0.5`, max delay < base delay) throws with the variable name. Commit `feat(US-08): add outbound retry settings`.
- [ ] T002 [P] Create the pure retry policy in `src/domain/outbound/retry-policy.ts` (data-model "State transitions", R5, R7), JSDoc on every export: `RetryPolicySettings` (`maxAttempts`, `baseDelayMs`, `multiplier`, `maxDelayMs`); `nextRetryDelay(attempt: number, settings): number` = `min(baseDelayMs × multiplier^(attempt−1), maxDelayMs)` with the exponent capped so it never overflows / becomes `Infinity`; `RetryAttemptResult` union `{ kind: 'success' } | { kind: 'transient'; error: string } | { kind: 'permanent'; error: string }`; `RetryDecision` (`status` `PENDING_RETRY`/`RESOLVED`/`EXHAUSTED` as a domain enum or string union, no TypeORM import; `retryCount`, `lastAttemptAt`, `lastError: string | null`, `nextRetryAt?`, `resolvedAt?`); `decideRetry(currentRetryCount, result, now: Date, settings): RetryDecision`. Tests in `tests/unit/domain/outbound-retry-policy.spec.ts`: delay table with defaults 5, 10, 20, 40, 80, 160, 300, 300, 300 s; cap holds at attempt 1000 (finite); multiplier 1 gives constant delay; success → `RESOLVED`, `resolvedAt=now`, `lastError=null`, count +1; transient below max → `PENDING_RETRY`, `nextRetryAt=now+delay(n)`; transient reaching max → `EXHAUSTED`, no `nextRetryAt`; `maxAttempts=1` exhausts on first failure; permanent → `EXHAUSTED` at once. Commit `feat(US-08): add the outbound retry policy`.
- [ ] T003 [P] Add `publishRaw(topic: string, key: string, value: Record<string, unknown>): Promise<void>` with JSDoc to `src/infra/kafka/lazy-kafka-producer.ts` (R6): same lazy connect and error behaviour as `publish`, sends `JSON.stringify(value)` with the given key unchanged, never awaits connect at startup. Extend `tests/unit/infra/lazy-kafka-producer.spec.ts`: sends the exact topic, key and serialized value; connects lazily on first call; a send failure rejects (so the caller can record it). Commit `feat(US-08): add a raw publish to the Kafka producer`.
- [ ] T004 Add `republish(topic: string, key: string, payload: Record<string, unknown>): Promise<void>` with JSDoc to the `UserEventPublisher` port in `src/services/ports/user-event-publisher.ts` and implement it in `src/infra/kafka/user-events.producer.ts` by delegating to `LazyKafkaProducer.publishRaw` (no re-derived key, no rebuilt payload) (R6). Update any test doubles of `UserEventPublisher` that must implement the new method (search `tests/` for `UserEventPublisher`). Extend `tests/unit/infra/user-events.producer.spec.ts`: delegates with the same topic/key/payload; propagates the rejection. Depends on T003. Commit `feat(US-08): add republish to the user event publisher`.
- [ ] T005 Add `processNextDue(handler: (row: OutboundDeadLetterRow) => Promise<RetryDecision>, now: Date): Promise<ProcessedRow | null>` with JSDoc to `src/repositories/outbound-dead-letter.repository.ts` (R4): one transaction; query builder select of one row with `topic = 'identity.user-registered'`, `status = PENDING_RETRY`, `"nextRetryAt" <= :now`, `ORDER BY "nextRetryAt", "createdAt"`, `setLock('pessimistic_write')` + `setOnLocked('skip_locked')`, `LIMIT 1`; maps the entity to a plain `OutboundDeadLetterRow` (id, eventId, topic, key, payload, retryCount) — no entity leaks out; runs the handler inside the transaction; writes only `status`, `retryCount`, `lastAttemptAt`, `lastError`, `nextRetryAt`, `resolvedAt` from the decision (never `error`, `payload`, `key`); commits; returns `{ row, decision }`, or `null` when nothing is due. A handler throw rolls back and rethrows (row unchanged). Uses the existing `(status, nextRetryAt)` index; no migration. Tests in new `tests/integration/outbound-dead-letter-claim.integration.spec.ts` (testcontainers PostgreSQL, same setup as `tests/integration/outbound-dead-letter.repository.integration.spec.ts`): returns `null` when empty; skips future `nextRetryAt`, `RESOLVED`, `EXHAUSTED` and other-topic rows; picks oldest `nextRetryAt` first; writes the decision fields and leaves `error`/`payload`/`key` unchanged; a throwing handler leaves the row exactly as before. Depends on T002 (`RetryDecision`). Commit `feat(US-08): claim due dead-letter rows with SKIP LOCKED`.

**Checkpoint**: policy, republish and claim exist and are tested; nothing runs them yet.

---

## Phase 3: User Story 1 — A missed registration event is eventually delivered (P1) 🎯 MVP

**Goal**: a due pending row is republished unchanged and marked `RESOLVED`.

**Independent test**: register with Kafka stopped → row `PENDING_RETRY`; start Kafka; one run → message on `identity.user-registered` with the same `eventId` and key; row `RESOLVED`, `resolvedAt` set.

- [ ] T006 [US1] Create `RetryOutboundEventsService` in `src/services/retry-outbound-events.service.ts` (`@Injectable`, JSDoc), injecting `OutboundDeadLetterRepository`, `UserEventPublisher`, `Clock` and the `outboundRetry` config (via `ConfigService`). `runBatch(): Promise<RetryRunSummary>` (`claimed`, `resolved`, `failed`, `exhausted`) loops up to `batchSize` times on `processNextDue`, stopping early on `null`; handler: if payload is an object with a string `eventId` → `republish(row.topic, row.key, row.payload)` → `decideRetry` with `success`, else `permanent`; a publish rejection → `transient` with the error message. Logs one `log` line per non-empty run with the four counts (context `RetryOutboundEventsService`); nothing at `log` level for an empty run. Also expose `requestStop()` / a stop flag checked before each row (used by T012). Tests in `tests/unit/services/retry-outbound-events.service.spec.ts` (mocked repository, publisher, fixed clock): due row → republish called with the stored topic/key/payload unchanged and decision `RESOLVED`; at most `batchSize` calls to `processNextDue`; stops at first `null`; summary log counts; empty run logs nothing at `log` level. Commit `feat(US-08): add the outbound retry service`.
- [ ] T007 [US1] Create `DeadLetterRetryWorker` in `src/infra/outbound/dead-letter-retry.worker.ts` (`@Injectable`, JSDoc) (R2): `onApplicationBootstrap` does nothing when `enabled=false`, otherwise schedules the first run one `intervalMs` later with a `setTimeout` that is `unref()`'d and never awaited; each run awaits `runBatch()`, catches and logs any rejection at `error` level (message only), then schedules the next run only after it finishes (no overlap). Expose `runOnce(): Promise<void>` for tests. Register `RetryOutboundEventsService` and `DeadLetterRetryWorker` in `src/app.module.ts`. Tests in `tests/unit/infra/dead-letter-retry.worker.spec.ts` (Jest fake timers): disabled → no timer; first run after one interval, not at bootstrap; next run scheduled only after the previous resolves (a slow `runBatch` spanning several intervals causes no second concurrent call); bootstrap returns synchronously. Commit `feat(US-08): schedule the outbound retry worker`.
- [ ] T008 [US1] Component test `tests/component/outbound-retry.component.spec.ts` (PostgreSQL + Kafka testcontainers, helpers from `tests/component/support/test-app.ts` and `tests/component/support/kafka-testing.ts`, `OUTBOUND_RETRY_ENABLED=false` and drive `runOnce()` manually): app A with `useUnreachableKafka()` → `POST /auth/register` 201 and one `PENDING_RETRY` row; close app A; start app B on the same database with the Kafka container's brokers and set the row due; app B `runOnce()` → exactly one message on `identity.user-registered` whose key equals the row key (user id) and whose JSON value has the same fields and values as the stored payload (same `eventId`); row `RESOLVED`, `resolvedAt` and `lastAttemptAt` set, `retryCount=1`, `lastError` null; a second `runOnce()` publishes nothing more. Also: a future-due row is not attempted; with 3 due rows and `OUTBOUND_RETRY_BATCH_SIZE=2`, the first run resolves the 2 oldest and the next run the third. Commit `test(US-08): cover redelivery after Kafka returns`.

**Checkpoint**: MVP — events stored during an outage reach Kafka once it is back.

---

## Phase 4: User Story 2 — Failures back off and eventually stop (P1)

**Goal**: failed attempts are recorded and rescheduled with capped exponential backoff, then `EXHAUSTED`.

**Independent test**: Kafka down, short delays, small `maxAttempts`: `retryCount`, `lastError`, `lastAttemptAt`, `nextRetryAt` grow per attempt, then `EXHAUSTED` with one `error` log line.

- [ ] T009 [US2] Extend `src/services/retry-outbound-events.service.ts` with the failure logging (R9, contracts "Log lines"): per rescheduled failure one `warn` with row id, `eventId`, topic, key, attempt n, next attempt time and error message; per exhaustion one `error` with row id, `eventId`, topic, key, attempts and last error; never the payload or any field of it. Per-row independence: a publish failure on one row does not stop the loop; a `processNextDue` rejection for one row (e.g. write failure after publish) is logged at `error` and the run ends without throwing. Extend `tests/unit/services/retry-outbound-events.service.spec.ts`: publish rejects → decision `PENDING_RETRY` with `nextRetryAt=now+delay(n)` and the warn line; failure at `maxAttempts` → `EXHAUSTED` and one error line; malformed payload (no `eventId`, non-object) → no publish, `EXHAUSTED` at once; mixed batch (fail, succeed, fail) → each row its own outcome and summary `{claimed:3, resolved:1, failed:2, exhausted:0}`; captured log lines (all levels) never contain the payload's `email`, `name`, `customerId` values (SC-006). Commit `feat(US-08): back off and exhaust failed retries`.
- [ ] T010 [US2] Component test `tests/component/outbound-retry-exhaust.component.spec.ts` (PostgreSQL testcontainer, Kafka unreachable, `OUTBOUND_RETRY_ENABLED=false`, `OUTBOUND_RETRY_MAX_ATTEMPTS=3`, `OUTBOUND_RETRY_BASE_DELAY_MS=1000`, `OUTBOUND_RETRY_MAX_DELAY_MS=1500`, capturing logger from `tests/component/support/capturing-logger.ts`): register → row; repeat `runOnce()` (moving `nextRetryAt` back to due before each) → after attempts 1 and 2 the row is `PENDING_RETRY` with `retryCount` 1/2, `lastError` and `lastAttemptAt` set and `nextRetryAt − lastAttemptAt` = 1000 ms then 1500 ms (cap); attempt 3 → `EXHAUSTED`, one `error` line with row id and `eventId`; a further run does not attempt it; no captured line contains the registered email. Commit `test(US-08): cover backoff and exhaustion with Kafka down`.

**Checkpoint**: an outage no longer causes a tight loop, and hopeless rows stop.

---

## Phase 5: User Story 3 — Safe with several instances and on shutdown (P2)

**Goal**: no row is claimed twice concurrently; shutdown finishes or releases every row.

**Independent test**: two concurrent claimers over the same due rows each get distinct rows; a worker stopped mid-run starts no new row and leaves unfinished rows due.

- [ ] T011 [P] [US3] Extend `tests/integration/outbound-dead-letter-claim.integration.spec.ts` (R4, SC-002): with 10 due rows, two `processNextDue` loops run concurrently with handlers that hold the lock briefly (await a short delay) → the union of claimed ids has no duplicates and covers all 10; while one transaction holds a row, a concurrent call gets a different row (or `null`) instead of blocking; a handler throw (simulated crash) releases the row unchanged and a later call claims it. Commit `test(US-08): prove SKIP LOCKED claims are exclusive`.
- [ ] T012 [US3] Add `onModuleDestroy` to `src/infra/outbound/dead-letter-retry.worker.ts` (R3, FR-011): clear the pending timer, call `RetryOutboundEventsService.requestStop()` so no new row is claimed, and await the in-flight run bounded by `outboundRetry.shutdownTimeoutMs`; after the bound, return without waiting; the abandoned run's promise keeps a `.catch` that logs at `warn` (constitution: no unhandled rejections), and its open transaction rolls back when the pool closes, leaving the row due. No new run is scheduled after destroy begins. Extend `tests/unit/infra/dead-letter-retry.worker.spec.ts`: destroy while idle clears the timer and no run follows; destroy during a run waits for it and schedules nothing afterwards; destroy with a run that never resolves returns after the bound; a run that rejects after the bound produces one log line and no unhandled rejection. Extend `tests/unit/services/retry-outbound-events.service.spec.ts`: after `requestStop()` the loop claims no further row. Commit `feat(US-08): stop the retry worker gracefully`.

**Checkpoint**: safe for horizontal scaling and rolling deploys.

---

## Phase 6: User Story 4 — The worker never harms the service (P2)

**Goal**: startup, health and registration are unaffected by Kafka or worker errors.

**Independent test**: start with Kafka down and due rows → startup completes, `/health` 200, register 201, worker keeps running.

- [ ] T013 [US4] Extend `tests/unit/infra/dead-letter-retry.worker.spec.ts` and `tests/unit/services/retry-outbound-events.service.spec.ts` (FR-009, FR-010): `runBatch` rejecting (e.g. database unreachable) → one `error` log, the next run is still scheduled on time, no unhandled rejection; a synchronous throw inside the run is caught the same way; `runBatch` resolves (does not throw) when `processNextDue` rejects on the first row. Fix the worker/service if any case fails. Commit `test(US-08): the retry worker survives run failures`.
- [ ] T014 [US4] Component test `tests/component/outbound-retry-kafka-unavailable.component.spec.ts` (PostgreSQL testcontainer, Kafka unreachable, worker enabled with `OUTBOUND_RETRY_INTERVAL_MS=200`, short delays): seed due `PENDING_RETRY` rows before app start → `app.init()` completes within the normal timeout; `GET /health` 200 (Kafka reported down, status up); `POST /auth/register` 201; after a few intervals the seeded rows have `retryCount ≥ 1` and the app still responds; `app.close()` completes without hanging. Commit `test(US-08): the service stays healthy with the retry worker and Kafka down`.

**Checkpoint**: all stories done.

---

## Phase 7: Polish & cross-cutting

- [ ] T015 [P] Document the worker in `README.md` (Events section: at-least-once redelivery, dedupe on `eventId`, `RESOLVED`/`EXHAUSTED`; Environment variables table: the seven `OUTBOUND_RETRY_*` variables with defaults and rules from contracts), `src/README.md` (worker → service → domain policy → repository flow) and `src/infra/kafka/README.md` (`publishRaw`/`republish`, keys unchanged). Commit `docs(US-08): document the outbound retry worker`.
- [ ] T016 [P] Add `docs/adr/0007-outbound-retry-per-row-skip-locked.md` from `docs/adr/template.md` ("Outbound retry claims one row per transaction with SKIP LOCKED": R4 with rejected batch-transaction and lease options, R2 self-rescheduling timer, R3 `onModuleDestroy`) and index it in `docs/adr/README.md`. Commit `docs(US-08): add ADR 0007 on the outbound retry worker`.
- [ ] T017 [P] In `../ecommerce-infra/docs/events.md`, add to `identity.user-registered` a note: may be redelivered (at-least-once) with the same `eventId`, key and payload after a Kafka outage; consumers deduplicate on `eventId`; schema unchanged. Also reference it in the `UserRegisteredEvent` class JSDoc (search `src/` for the event class). Commit in this repo `docs(US-08): note at-least-once redelivery of user-registered`; commit the infra change in `ecommerce-infra` on a `docs/` branch (do not push without asking).
- [ ] T018 Run `specs/008-outbound-retry-worker/quickstart.md` manually against `npm run start:dev` and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-08): record the manual quickstart run`.

---

## Dependencies & execution order

- **Foundational (T001–T005)** → stories. T001, T002, T003 in parallel; T004 after T003; T005 after T002.
- **US1 (T006–T008)**: T006 (needs T001, T002, T004, T005) → T007 → T008. MVP.
- **US2 (T009–T010)**: T009 after T006; T010 after T007 + T009.
- **US3 (T011–T012)**: T011 any time after T005; T012 after T007 and T009.
- **US4 (T013–T014)**: after T012.
- **Polish**: T015–T017 parallel after T014; T018 last.
- Shared files (sequential tasks): `src/services/retry-outbound-events.service.ts` (T006, T009, T012), `src/infra/outbound/dead-letter-retry.worker.ts` (T007, T012), `tests/unit/services/retry-outbound-events.service.spec.ts` (T006, T009, T012, T013), `tests/unit/infra/dead-letter-retry.worker.spec.ts` (T007, T012, T013), `tests/integration/outbound-dead-letter-claim.integration.spec.ts` (T005, T011).

```text
{T001, T002, T003} [P] ; T003 → T004 ; T002 → T005
T001+T002+T004+T005 → T006 → T007 → T008 (US1 MVP)
T006 → T009 (US2) → T010
T005 → T011 (US3) ; T007+T009 → T012
T012 → T013 (US4) → T014
→ Polish T015..T017 [P] → T018
```

## Parallel examples

- Foundational: T001 (config), T002 (policy) and T003 (Kafka producer) together; T004 and T005 once their dependency is done.
- US3: T011 (integration test) alongside US1/US2 work once T005 is done.
- Polish: T015, T016, T017 together.

## Implementation strategy

1. **MVP**: T001–T008: events stored during an outage are redelivered unchanged once Kafka is back.
2. US2 adds backoff and exhaustion so outages never cause tight loops or endless retries.
3. US3 proves multi-instance safety and adds graceful shutdown; US4 proves the worker never harms startup, health or registration.
4. Polish: docs, ADR 0007, infra event note, manual quickstart.
5. Gate green and commit after every task; push the branch after T018 (the user opens the PR).
