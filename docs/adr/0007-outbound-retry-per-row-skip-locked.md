# 0007. Outbound retry claims one row per transaction with SKIP LOCKED

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

When publishing `identity.user-registered` fails after the user is committed, the event is stored
in `outbound_dead_letters` as `PENDING_RETRY` (US-01). Without a worker that redelivers these
rows, a registration made during a Kafka outage never reaches Orders. The constitution (Principle
VIII) requires the worker to claim due rows with `SELECT … FOR UPDATE SKIP LOCKED`, republish with
the same `eventId`, back off exponentially and end each row as `RESOLVED` or `EXHAUSTED`.

Constraints:

- Every instance runs the worker (no leader election), so two instances must never take the same
  row.
- Kafka may be down for minutes; a publish can take seconds before it fails.
- A crash or a rolling deploy must not leave a row half-updated or claimed forever.
- The worker must never delay startup, affect `/health` or crash the process.

## Decision

We will claim **one row per transaction**: `OutboundDeadLetterRepository.processNextDue` opens a
transaction, selects the oldest due row with `FOR UPDATE SKIP LOCKED`, republishes it while the
row is locked, writes the next state from the pure domain `decideRetry`, and commits. A run
repeats this up to `OUTBOUND_RETRY_BATCH_SIZE` times.

We will schedule runs with a **self-rescheduling `setTimeout`** (`unref()`'d) in
`DeadLetterRetryWorker`: the first run starts one interval after bootstrap, and each run schedules
the next only after it finishes.

We will stop the worker in **`onModuleDestroy`**: clear the timer, stop claiming rows, and wait for
the run in progress for at most `OUTBOUND_RETRY_SHUTDOWN_TIMEOUT_MS`.

Rejected alternatives:

- **One transaction for the whole batch.** Up to 20 rows stay locked, and one connection is held,
  across slow publishes while Kafka is down.
- **Claim with a lease, publish outside the transaction.** Needs a lease longer than the worst
  batch, plus bookkeeping to expire it; a crashed instance's rows wait for the lease to run out.
- **`setInterval` or `@nestjs/schedule`.** `setInterval` overlaps runs when publishes are slow;
  `@nestjs/schedule` adds a dependency and still needs a re-entrancy guard.
- **Stopping in `onApplicationShutdown`.** The Kafka producer and the TypeORM pool close in that
  hook too, so a run in progress could race them; Nest runs every `onModuleDestroy` first.

## Consequences

- Instances never process the same row, and a crash or shutdown rolls the row back: it stays
  `PENDING_RETRY` and due, with no lease to expire.
- A lock and a connection are held for one publish only.
- Delivery is at-least-once: if Kafka accepts a message but the commit then fails, the row is
  published again later. Consumers deduplicate on `eventId` (already required by the constitution).
- `jsonb` does not keep key order, so a redelivered value has the same fields and values but may
  differ byte-wise from the original.
- Strict global ordering across instances is not guaranteed; each instance takes the oldest due
  row it can lock.
- A batch is processed sequentially; with the defaults one instance drains about 20 rows per
  30 s run, which fits the expected volume (rows exist only during Kafka outages).
